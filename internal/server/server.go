// SPDX-License-Identifier: AGPL-3.0-or-later

// Package server is the HTTP side of `glitchmonitor serve`: the embedded SPA,
// the probe endpoints, CORS, and graceful shutdown.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strconv"
	"sync/atomic"
	"time"

	"glitchmonitor/internal/config"
	"glitchmonitor/internal/internalprobe"
	"glitchmonitor/internal/probe"
)

// shutdownTimeout bounds http.Server.Shutdown. Together with the default
// shutdownDelay it stays well inside terminationGracePeriodSeconds: 30.
const shutdownTimeout = 10 * time.Second

// maxSparkSeconds is as far back as the internal probes remember.
const maxSparkSeconds = 600

// Identity is who this pod is, from the Downward API.
type Identity struct {
	Pod       string
	Node      string
	PodIP     string
	Namespace string
}

// About is what the dashboard shows to meet the AGPL's notice and
// source-offer terms: which build this is, where its source is, and the licence text.
type About struct {
	Version   string `json:"version"`
	SourceURL string `json:"sourceURL"`
	License   []byte `json:"-"`
	// ThirdParty is the notices and licence texts of the components the app includes.
	ThirdParty []byte `json:"-"`
	// Samples are the demo recordings served under /demo/, for "?saved=demo/<name>.json"; may be nil.
	Samples fs.FS `json:"-"`
}

// InternalReporter is the internal probes of this pod; see internalprobe.Manager.
type InternalReporter interface {
	Report(withResults bool, since time.Time) internalprobe.Report
	Sparks(seconds int) map[string]probe.Spark
}

type Server struct {
	cfg    *config.Config
	id     Identity
	about  About
	static fs.FS
	log    *slog.Logger

	// Internal is nil when this process runs no internal probes, as it does outside a cluster.
	Internal InternalReporter

	seq         atomic.Uint64
	terminating atomic.Bool
}

func New(cfg *config.Config, id Identity, about About, static fs.FS, log *slog.Logger) *Server {
	return &Server{cfg: cfg, id: id, about: about, static: static, log: log}
}

func (s *Server) Handler() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/config", s.handleConfig)
	api.HandleFunc("GET /api/ping", s.handlePing)
	api.HandleFunc("GET /api/internal", s.handleInternal)

	mux := http.NewServeMux()
	mux.Handle("/api/", s.cors(api))
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)
	mux.HandleFunc("GET /LICENSE", s.plainText(s.about.License))
	mux.HandleFunc("GET /THIRD-PARTY-NOTICES", s.plainText(s.about.ThirdParty))
	if s.about.Samples != nil {
		mux.Handle("GET /demo/", http.StripPrefix("/demo/", http.FileServerFS(s.about.Samples)))
	}
	mux.Handle("/", s.staticFiles())
	return s.closeWhenTerminating(mux)
}

type pingResponse struct {
	Pod        string `json:"pod"`
	Node       string `json:"node"`
	PodIP      string `json:"podIP"`
	ServerTime string `json:"serverTime"`
	Seq        uint64 `json:"seq"`
}

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, pingResponse{
		Pod:        s.id.Pod,
		Node:       s.id.Node,
		PodIP:      s.id.PodIP,
		ServerTime: time.Now().UTC().Format(time.RFC3339Nano),
		Seq:        s.seq.Add(1),
	})
}

type configResponse struct {
	External []config.External `json:"external"`
	Browser  config.Browser    `json:"browser"`
	About    About             `json:"about"`
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	external := s.cfg.External
	if external == nil {
		external = []config.External{}
	}
	writeJSON(w, http.StatusOK, configResponse{External: external, Browser: s.cfg.Browser, About: s.about})
}

// handleInternal reports what this pod's internal probes see. The ring of raw
// results is large, so it is only included on request: ?results=all for all
// of it, or ?since=<epoch ms> for the results sent after that time.
// ?spark=<seconds> adds a small per-second history for mini graphs.
func (s *Server) handleInternal(w http.ResponseWriter, r *http.Request) {
	if s.Internal == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "this process runs no internal probes"})
		return
	}
	q := r.URL.Query()
	withResults := q.Get("results") == "all"
	var since time.Time
	if v := q.Get("since"); v != "" {
		ms, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "since must be a time in epoch milliseconds"})
			return
		}
		withResults, since = true, time.UnixMilli(ms)
	}
	report := s.Internal.Report(withResults, since)
	if v := q.Get("spark"); v != "" {
		seconds, err := strconv.Atoi(v)
		if err != nil || seconds < 1 || seconds > maxSparkSeconds {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "spark must be a number of seconds from 1 to 600"})
			return
		}
		report.Sparks = s.Internal.Sparks(seconds)
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeText(w, http.StatusOK, "ok\n")
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if s.terminating.Load() {
		writeText(w, http.StatusServiceUnavailable, "terminating\n")
		return
	}
	writeText(w, http.StatusOK, "ok\n")
}

func (s *Server) plainText(text []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Type", "text/plain; charset=utf-8")
		h.Set("Cache-Control", "no-cache")
		w.Write(text)
	}
}

func (s *Server) staticFiles() http.Handler {
	files := http.FileServerFS(s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Revalidate on every load, so a new image is picked up without a hard refresh.
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
}

// cors echoes the Origin header when it is on the allow list, and answers
// preflight requests. The SPA's own probes are simple GETs and never preflight.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		allowed := origin != "" && s.originAllowed(origin)
		if allowed {
			h.Set("Access-Control-Allow-Origin", origin)
		}
		if r.Method == http.MethodOptions {
			h.Set("Allow", "GET, HEAD, OPTIONS")
			if allowed {
				h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
				if req := r.Header.Get("Access-Control-Request-Headers"); req != "" {
					h.Set("Access-Control-Allow-Headers", req)
				}
				h.Set("Access-Control-Max-Age", "600")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	return slices.Contains(s.cfg.CORSAllowedOrigins, origin) || slices.Contains(s.cfg.CORSAllowedOrigins, "*")
}

// closeWhenTerminating asks clients to stop reusing their connection once
// SIGTERM has arrived, so routers move off this pod during shutdownDelay
// instead of racing http.Server.Shutdown on an idle keep-alive connection.
func (s *Server) closeWhenTerminating(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.terminating.Load() {
			w.Header().Set("Connection", "close")
		}
		next.ServeHTTP(w, r)
	})
}

// Run serves on ln until ctx is cancelled (SIGTERM), then shuts down
// gracefully: readiness goes false, the server keeps answering for
// shutdownDelay while endpoints and routers catch up, then it drains.
func (s *Server) Run(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		// No IdleTimeout: closing idle keep-alive connections from this side
		// races with routers reusing them and would show up as glitches.
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}

	s.terminating.Store(true)
	delay := time.Duration(s.cfg.Server.ShutdownDelay)
	s.log.Info("termination requested, readiness is now false", "shutdownDelay", delay.String())
	time.Sleep(delay)

	sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	err := srv.Shutdown(sctx)
	if serveErr := <-errc; !errors.Is(serveErr, http.ErrServerClosed) {
		err = errors.Join(err, serveErr)
	}
	s.log.Info("server stopped")
	return err
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeText(w http.ResponseWriter, status int, body string) {
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write([]byte(body))
}
