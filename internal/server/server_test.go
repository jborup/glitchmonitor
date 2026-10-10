// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"glitchmonitor/internal/config"
	"glitchmonitor/internal/internalprobe"
	"glitchmonitor/internal/probe"
)

const (
	appsOrigin = "https://glitchmonitor.apps.example.com"
	gtwOrigin  = "https://glitchmonitor.gtw.example.com"
)

func newTestServer(mutate func(*config.Config)) *Server {
	cfg := config.Default()
	cfg.External = []config.External{
		{Name: "route", URL: appsOrigin, Enabled: true},
		{Name: "gateway", URL: gtwOrigin, Enabled: false},
	}
	cfg.CORSAllowedOrigins = []string{appsOrigin, gtwOrigin}
	if mutate != nil {
		mutate(cfg)
	}
	static := fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>glitchmonitor</title>")}}
	id := Identity{Pod: "glitchmonitor-abc", Node: "node-1", PodIP: "10.128.0.7", Namespace: "glitchmonitor"}
	about := About{Version: "1.2.3", SourceURL: "https://example.com/src", License: []byte("GNU AFFERO GENERAL PUBLIC LICENSE\n"),
		ThirdParty: []byte("# Third-party notices\n")}
	return New(cfg, id, about, static, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func do(h http.Handler, method, path string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestPing(t *testing.T) {
	h := newTestServer(nil).Handler()
	var last uint64
	for i := 0; i < 3; i++ {
		rec := do(h, "GET", "/api/ping", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("Cache-Control = %q, want no-store", got)
		}
		var p pingResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Pod != "glitchmonitor-abc" || p.Node != "node-1" || p.PodIP != "10.128.0.7" {
			t.Errorf("identity = %+v", p)
		}
		if _, err := time.Parse(time.RFC3339Nano, p.ServerTime); err != nil {
			t.Errorf("serverTime %q: %v", p.ServerTime, err)
		}
		if p.Seq <= last {
			t.Errorf("seq %d did not increase past %d", p.Seq, last)
		}
		last = p.Seq
	}
}

func TestConfigEndpoint(t *testing.T) {
	rec := do(newTestServer(nil).Handler(), "GET", "/api/config", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got configResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.External) != 2 || got.External[0].URL != appsOrigin || got.External[1].Enabled {
		t.Errorf("external = %+v", got.External)
	}
	if got.Browser != config.Default().Browser {
		t.Errorf("browser = %+v", got.Browser)
	}
}

// The dashboard footer needs these to state the version and offer the source (AGPL section 13).
func TestAboutAndLicense(t *testing.T) {
	h := newTestServer(nil).Handler()
	var got configResponse
	if err := json.Unmarshal(do(h, "GET", "/api/config", nil).Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.About.Version != "1.2.3" || got.About.SourceURL != "https://example.com/src" {
		t.Errorf("about = %+v", got.About)
	}
	rec := do(h, "GET", "/LICENSE", nil)
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
		t.Fatalf("GET /LICENSE = %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "GNU AFFERO GENERAL PUBLIC LICENSE") {
		t.Errorf("licence body = %q", rec.Body.String())
	}
	rec = do(h, "GET", "/THIRD-PARTY-NOTICES", nil)
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
		t.Fatalf("GET /THIRD-PARTY-NOTICES = %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "Third-party notices") {
		t.Errorf("notices body = %q", rec.Body.String())
	}
}

type fakeInternal struct {
	withResults bool
	since       time.Time
}

func (f *fakeInternal) Report(withResults bool, since time.Time) internalprobe.Report {
	f.withResults, f.since = withResults, since
	return internalprobe.Report{Pod: "glitchmonitor-abc", Targets: []internalprobe.TargetReport{{ID: "service/fresh"}}}
}

func (f *fakeInternal) Sparks(seconds int) map[string]probe.Spark {
	return map[string]probe.Spark{"service/fresh": {Start: 1, LatencyMs: make([]float64, seconds), Failures: make([]int, seconds)}}
}

func TestInternalEndpoint(t *testing.T) {
	s := newTestServer(nil)
	h := s.Handler()
	if rec := do(h, "GET", "/api/internal", nil); rec.Code != http.StatusNotFound {
		t.Errorf("without internal probes: status = %d, want 404", rec.Code)
	}

	fake := &fakeInternal{}
	s.Internal = fake
	rec := do(h, "GET", "/api/internal", map[string]string{"Origin": gtwOrigin})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != gtwOrigin {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, gtwOrigin)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	var report internalprobe.Report
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Pod != "glitchmonitor-abc" || len(report.Targets) != 1 {
		t.Errorf("report = %+v", report)
	}
	if fake.withResults {
		t.Error("raw results must not be included by default")
	}

	do(h, "GET", "/api/internal?results=all", nil)
	if !fake.withResults || !fake.since.IsZero() {
		t.Errorf("results=all: withResults=%v since=%v", fake.withResults, fake.since)
	}
	do(h, "GET", "/api/internal?since=1767322445000", nil)
	if !fake.withResults || fake.since.UnixMilli() != 1767322445000 {
		t.Errorf("since: withResults=%v since=%v", fake.withResults, fake.since)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil || report.Sparks != nil {
		t.Errorf("sparks included without being asked for: %v %v", report.Sparks, err)
	}
	rec = do(h, "GET", "/api/internal?spark=60", nil)
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil || len(report.Sparks["service/fresh"].LatencyMs) != 60 {
		t.Errorf("spark=60: %+v %v", report.Sparks, err)
	}
	for _, bad := range []string{"0", "601", "many"} {
		if rec := do(h, "GET", "/api/internal?spark="+bad, nil); rec.Code != http.StatusBadRequest {
			t.Errorf("spark=%s: status = %d, want 400", bad, rec.Code)
		}
	}
	if rec := do(h, "GET", "/api/internal?since=yesterday", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("bad since: status = %d, want 400", rec.Code)
	}
}

func TestConfigEndpointWithoutTargetsReturnsEmptyArray(t *testing.T) {
	h := newTestServer(func(c *config.Config) { c.External = nil }).Handler()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(do(h, "GET", "/api/config", nil).Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if string(raw["external"]) != "[]" {
		t.Errorf("external = %s, want []", raw["external"])
	}
}

func TestCORS(t *testing.T) {
	h := newTestServer(nil).Handler()
	cases := []struct {
		name, origin, want string
	}{
		{"allowed apps origin", appsOrigin, appsOrigin},
		{"allowed gtw origin", gtwOrigin, gtwOrigin},
		{"unknown origin", "https://evil.example.com", ""},
		{"scheme must match", "http://glitchmonitor.apps.example.com", ""},
		{"no origin header", "", ""},
	}
	for _, path := range []string{"/api/ping", "/api/config"} {
		for _, tc := range cases {
			t.Run(path+" "+tc.name, func(t *testing.T) {
				header := map[string]string{}
				if tc.origin != "" {
					header["Origin"] = tc.origin
				}
				rec := do(h, "GET", path, header)
				if rec.Code != http.StatusOK {
					t.Fatalf("status = %d", rec.Code)
				}
				if got := rec.Header().Get("Access-Control-Allow-Origin"); got != tc.want {
					t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, tc.want)
				}
				if got := rec.Header().Get("Vary"); got != "Origin" {
					t.Errorf("Vary = %q, want Origin", got)
				}
			})
		}
	}
}

func TestCORSWildcard(t *testing.T) {
	h := newTestServer(func(c *config.Config) { c.CORSAllowedOrigins = []string{"*"} }).Handler()
	rec := do(h, "GET", "/api/ping", map[string]string{"Origin": "https://anything.example.com"})
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://anything.example.com" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
}

func TestPreflight(t *testing.T) {
	h := newTestServer(nil).Handler()

	rec := do(h, "OPTIONS", "/api/ping", map[string]string{
		"Origin":                         gtwOrigin,
		"Access-Control-Request-Method":  "GET",
		"Access-Control-Request-Headers": "x-probe-id",
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	for k, want := range map[string]string{
		"Access-Control-Allow-Origin":  gtwOrigin,
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		"Access-Control-Allow-Headers": "x-probe-id",
		"Access-Control-Max-Age":       "600",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}

	rec = do(h, "OPTIONS", "/api/ping", map[string]string{
		"Origin":                        "https://evil.example.com",
		"Access-Control-Request-Method": "GET",
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	for _, k := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Methods"} {
		if got := rec.Header().Get(k); got != "" {
			t.Errorf("%s = %q for a disallowed origin", k, got)
		}
	}
}

func TestMethodNotAllowed(t *testing.T) {
	rec := do(newTestServer(nil).Handler(), "POST", "/api/ping", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rec.Code)
	}
}

func TestStaticAndHealth(t *testing.T) {
	h := newTestServer(nil).Handler()
	if rec := do(h, "GET", "/", nil); rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("GET / = %d, Cache-Control %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if rec := do(h, "GET", "/nope.js", nil); rec.Code != http.StatusNotFound {
		t.Errorf("GET /nope.js = %d, want 404", rec.Code)
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		if rec := do(h, "GET", path, nil); rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, rec.Code)
		}
	}
}

func get(t *testing.T, client *http.Client, url string) *http.Response {
	t.Helper()
	resp, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp
}

// After SIGTERM the pod must report not-ready but keep serving for
// shutdownDelay, and only then stop.
func TestGracefulShutdown(t *testing.T) {
	const delay = 400 * time.Millisecond
	s := newTestServer(func(c *config.Config) { c.Server.ShutdownDelay = config.Duration(delay) })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, ln) }()

	client := &http.Client{Timeout: 2 * time.Second}
	if resp := get(t, client, base+"/readyz"); resp.StatusCode != http.StatusOK {
		t.Fatalf("readyz before SIGTERM = %d", resp.StatusCode)
	}

	cancel()
	start := time.Now()
	deadline := start.Add(delay)
	for s.terminating.Load() == false && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}

	if resp := get(t, client, base+"/readyz"); resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("readyz during shutdownDelay = %d, want 503", resp.StatusCode)
	}
	resp := get(t, client, base+"/api/ping")
	if resp.StatusCode != http.StatusOK {
		t.Errorf("ping during shutdownDelay = %d, want 200", resp.StatusCode)
	}
	if !resp.Close {
		t.Error("ping during shutdownDelay should carry Connection: close")
	}
	if resp := get(t, client, base+"/healthz"); resp.StatusCode != http.StatusOK {
		t.Errorf("healthz during shutdownDelay = %d, want 200", resp.StatusCode)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
	if elapsed := time.Since(start); elapsed < delay {
		t.Errorf("server stopped after %v, before shutdownDelay %v", elapsed, delay)
	}
	if _, err := client.Get(base + "/api/ping"); err == nil {
		t.Error("server still answers after shutdown")
	}
}

func TestZeroShutdownDelayStopsImmediately(t *testing.T) {
	s := newTestServer(func(c *config.Config) { c.Server.ShutdownDelay = 0 })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, ln) }()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not stop promptly with shutdownDelay 0")
	}
}
