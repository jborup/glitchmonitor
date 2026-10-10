// SPDX-License-Identifier: AGPL-3.0-or-later

// Package internalprobe runs the probes every pod makes from inside the
// cluster: the Service, each peer pod directly, and the API server. Comparing
// them with what the browser sees from outside tells a Service, network or
// endpoint-propagation problem apart from a pod that is really down.
package internalprobe

import (
	"cmp"
	"context"
	"crypto/tls"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"sync"
	"time"

	"glitchmonitor/internal/config"
	"glitchmonitor/internal/kube"
	"glitchmonitor/internal/probe"
)

const (
	// history is how far back each target's ring of results reaches.
	history = 10 * time.Minute
	// peerRefresh is how often the headless Service is resolved again.
	peerRefresh = 2 * time.Second
)

// EndpointsSource says which pod IPs are ready endpoints of the Service.
type EndpointsSource interface {
	Ready(ip string) (ready, known bool)
	Status() (synced, connected bool, changes []kube.Change)
}

// Options say what to probe. Zero values turn the corresponding target off.
type Options struct {
	Config *config.Config
	Pod    string
	Node   string
	PodIP  string

	ServiceURL string                 // the ClusterIP Service's /api/ping
	PeersHost  string                 // the headless Service to resolve for pod IPs
	PodURL     func(ip string) string // /api/ping on one pod
	APIServer  *kube.InCluster        // nil: no API server target
	Endpoints  EndpointsSource        // nil: pods are not tagged with "in endpoints"

	// Resolve looks up the peer pod IPs; nil uses DNS.
	Resolve func(ctx context.Context, host string) ([]string, error)
	Log     *slog.Logger
}

type target struct {
	id, kind, mode, url string
	podIP               string
	self                bool
	state               *probe.Target
	stop                context.CancelFunc // pod targets: stops probing when the pod is gone
	goneAt              time.Time          // pod targets: when it left DNS; zero while active
}

type Manager struct {
	opts    Options
	started time.Time

	mu        sync.Mutex
	targets   map[string]*target
	peerError string
}

func New(opts Options) *Manager {
	if opts.Resolve == nil {
		opts.Resolve = net.DefaultResolver.LookupHost
	}
	return &Manager{opts: opts, started: time.Now(), targets: map[string]*target{}}
}

// Run probes until ctx is cancelled.
func (m *Manager) Run(ctx context.Context) {
	in := m.opts.Config.Internal
	browser := m.opts.Config.Browser

	if in.Targets.Service.Enabled && m.opts.ServiceURL != "" {
		for _, mode := range in.Targets.Service.Modes {
			// A kept-alive connection stays on the one pod it was balanced to, so
			// only fresh connections can tell how many pods answer.
			replicas := 1
			if mode == "fresh" {
				replicas = browser.ExpectedReplicas
			}
			t := m.add(&target{id: "service/" + mode, kind: "service", mode: mode, url: m.opts.ServiceURL}, replicas)
			go probe.Run(ctx, m.spec(t, nil, nil), t.state)
		}
	}
	if api := m.opts.APIServer; in.Targets.APIServer.Enabled && api != nil {
		t := m.add(&target{id: "apiserver", kind: "apiserver", mode: "fresh", url: api.URL + "/readyz"}, 1)
		header := func(req *http.Request) {
			if token, err := api.Token(); err == nil {
				req.Header.Set("Authorization", "Bearer "+token)
			}
		}
		spec := m.spec(t, api.TLS, header)
		spec.Parse = nil
		go probe.Run(ctx, spec, t.state)
	}
	if in.Targets.PodDirect.Enabled && m.opts.PeersHost != "" {
		m.followPeers(ctx)
		return
	}
	<-ctx.Done()
}

func (m *Manager) add(t *target, expectedReplicas int) *target {
	in := m.opts.Config.Internal
	t.state = probe.NewTarget(probe.TrackerOptions{
		FailThreshold:    m.opts.Config.Internal.FailThreshold,
		ExpectedReplicas: expectedReplicas,
		PodWindow:        time.Duration(m.opts.Config.Browser.PodWindowSec) * time.Second,
	}, int(history/(time.Duration(in.IntervalMs)*time.Millisecond)))
	m.mu.Lock()
	m.targets[t.id] = t
	m.mu.Unlock()
	return t
}

func (m *Manager) spec(t *target, tlsConfig *tls.Config, header func(*http.Request)) probe.Spec {
	in := m.opts.Config.Internal
	return probe.Spec{
		URL:            t.url,
		Interval:       time.Duration(in.IntervalMs) * time.Millisecond,
		Timeout:        time.Duration(in.TimeoutMs) * time.Millisecond,
		ConnectTimeout: time.Duration(in.ConnectTimeoutMs) * time.Millisecond,
		Retry:          in.Retry,
		Slow:           time.Duration(in.SlowMs) * time.Millisecond,
		Fresh:          t.mode == "fresh",
		TLS:            tlsConfig,
		Header:         header,
		Parse:          probe.ParsePing,
	}
}

// followPeers keeps one pod-direct target per mode for every pod IP behind
// the headless Service, this pod included. The headless Service also lists
// pods that are not ready, so a pod is probed until it is really gone.
func (m *Manager) followPeers(ctx context.Context) {
	ticker := time.NewTicker(peerRefresh)
	defer ticker.Stop()
	for {
		m.refreshPeers(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (m *Manager) refreshPeers(ctx context.Context) {
	lookup, cancel := context.WithTimeout(ctx, peerRefresh)
	ips, err := m.opts.Resolve(lookup, m.opts.PeersHost)
	cancel()

	m.mu.Lock()
	if err != nil {
		// Keep probing the pods already known: DNS being down is no reason to stop.
		m.peerError = err.Error()
		m.mu.Unlock()
		return
	}
	m.peerError = ""
	now := time.Now()
	for _, t := range m.targets {
		if t.kind != "pod" {
			continue
		}
		switch {
		case slices.Contains(ips, t.podIP):
		case t.goneAt.IsZero():
			t.goneAt = now
			t.stop()
			t.state.Retire(now, "the pod is gone")
		case now.Sub(t.goneAt) > history:
			delete(m.targets, t.id)
		}
	}
	m.mu.Unlock()

	for _, ip := range ips {
		for _, mode := range m.opts.Config.Internal.Targets.PodDirect.Modes {
			id := "pod/" + ip + "/" + mode
			m.mu.Lock()
			existing := m.targets[id]
			active := existing != nil && existing.goneAt.IsZero()
			m.mu.Unlock()
			if active {
				continue
			}
			podCtx, stop := context.WithCancel(ctx)
			t := m.add(&target{
				id: id, kind: "pod", mode: mode, url: m.opts.PodURL(ip),
				podIP: ip, self: ip == m.opts.PodIP, stop: stop,
			}, 1)
			spec := m.spec(t, nil, nil)
			spec.Annotate = func(r *probe.Result) { r.InEndpoints = m.inEndpoints(ip) }
			go probe.Run(podCtx, spec, t.state)
		}
	}
}

func (m *Manager) inEndpoints(ip string) *bool {
	if m.opts.Endpoints == nil {
		return nil
	}
	ready, known := m.opts.Endpoints.Ready(ip)
	if !known {
		return nil
	}
	return &ready
}

// TargetReport is one target in the report.
type TargetReport struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"` // "service", "pod" or "apiserver"
	Mode   string `json:"mode"` // "keepalive" or "fresh"
	URL    string `json:"url"`
	PodIP  string `json:"podIP,omitempty"`
	Self   bool   `json:"self,omitempty"` // a pod target that is the reporting pod itself
	Active bool   `json:"active"`         // false once a pod has left the headless Service
	// InEndpoints: for a pod target, whether it is a ready endpoint of the
	// Service right now; null when not known.
	InEndpoints *bool `json:"inEndpoints"`
	probe.Snapshot
}

// EndpointChange is a pod IP becoming, or no longer being, a ready endpoint.
type EndpointChange struct {
	T     int64  `json:"t"`
	IP    string `json:"ip"`
	Ready bool   `json:"ready"`
}

// Report is the body of /api/internal: what this pod sees from the inside.
type Report struct {
	Pod              string `json:"pod"`
	Node             string `json:"node"`
	PodIP            string `json:"podIP"`
	ServerTime       int64  `json:"serverTime"`
	StartedAt        int64  `json:"startedAt"` // counters count from here
	IntervalMs       int    `json:"intervalMs"`
	TimeoutMs        int    `json:"timeoutMs"`
	SlowMs           int    `json:"slowMs"`
	ConnectTimeoutMs int    `json:"connectTimeoutMs"`
	Retry            bool   `json:"retry"`
	Endpoints        struct {
		Watching  bool             `json:"watching"`  // false: this pod does not watch EndpointSlices
		Synced    bool             `json:"synced"`    // loaded at least once
		Connected bool             `json:"connected"` // false: the state shown may be out of date
		Changes   []EndpointChange `json:"changes"`
	} `json:"endpoints"`
	PeerError string         `json:"peerError,omitempty"` // why the peer pods could not be looked up
	Targets   []TargetReport `json:"targets"`
	// Sparks: a short per-second history by target id, only when asked for with ?spark=<seconds>.
	Sparks map[string]probe.Spark `json:"sparks,omitempty"`
}

// Sparks returns a per-second history of the last `seconds` seconds for every
// target, by target id: the data for the dashboard's mini graphs.
func (m *Manager) Sparks(seconds int) map[string]probe.Spark {
	m.mu.Lock()
	targets := make(map[string]*probe.Target, len(m.targets))
	for id, t := range m.targets {
		targets[id] = t.state
	}
	m.mu.Unlock()
	now := time.Now()
	out := make(map[string]probe.Spark, len(targets))
	for id, state := range targets {
		out[id] = state.Spark(now, seconds)
	}
	return out
}

// Report returns the current state of every target. With results, each target
// also carries its results sent after since (the whole ring for a zero time).
func (m *Manager) Report(withResults bool, since time.Time) Report {
	in := m.opts.Config.Internal
	r := Report{
		Pod: m.opts.Pod, Node: m.opts.Node, PodIP: m.opts.PodIP,
		ServerTime: time.Now().UnixMilli(), StartedAt: m.started.UnixMilli(),
		IntervalMs: in.IntervalMs, TimeoutMs: in.TimeoutMs, SlowMs: in.SlowMs,
		ConnectTimeoutMs: in.ConnectTimeoutMs, Retry: in.Retry,
		Targets: []TargetReport{},
	}
	r.Endpoints.Changes = []EndpointChange{}
	if ep := m.opts.Endpoints; ep != nil {
		synced, connected, changes := ep.Status()
		r.Endpoints.Watching, r.Endpoints.Synced, r.Endpoints.Connected = true, synced, connected
		for _, c := range changes {
			r.Endpoints.Changes = append(r.Endpoints.Changes, EndpointChange{T: c.T.UnixMilli(), IP: c.IP, Ready: c.Ready})
		}
	}

	m.mu.Lock()
	r.PeerError = m.peerError
	targets := make([]target, 0, len(m.targets))
	for _, t := range m.targets {
		targets = append(targets, *t)
	}
	m.mu.Unlock()
	slices.SortFunc(targets, func(a, b target) int { return cmp.Compare(a.id, b.id) })

	for _, t := range targets {
		tr := TargetReport{
			ID: t.id, Kind: t.kind, Mode: t.mode, URL: t.url, PodIP: t.podIP, Self: t.self,
			Active:   t.goneAt.IsZero(),
			Snapshot: t.state.Snapshot(withResults, since),
		}
		if t.kind == "pod" {
			tr.InEndpoints = m.inEndpoints(t.podIP)
		}
		r.Targets = append(r.Targets, tr)
	}
	return r
}
