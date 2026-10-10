// SPDX-License-Identifier: AGPL-3.0-or-later

package internalprobe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"glitchmonitor/internal/config"
	"glitchmonitor/internal/kube"
)

// pingServer answers like one pod's /api/ping.
func pingServer(t *testing.T, pod, node string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"pod":%q,"node":%q}`, pod, node)
	}))
	t.Cleanup(srv.Close)
	return srv
}

type fakeEndpoints struct {
	mu    sync.Mutex
	ready map[string]bool
}

func (f *fakeEndpoints) Ready(ip string) (bool, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ready[ip], true
}

func (f *fakeEndpoints) Status() (bool, bool, []kube.Change) {
	return true, true, []kube.Change{{T: time.UnixMilli(1000), IP: "ip-b", Ready: false}}
}

func (f *fakeEndpoints) set(ip string, ready bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ready[ip] = ready
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func find(r Report, id string) *TargetReport {
	for i := range r.Targets {
		if r.Targets[i].ID == id {
			return &r.Targets[i]
		}
	}
	return nil
}

func TestManager(t *testing.T) {
	podA := pingServer(t, "pod-a", "node-1")
	podB := pingServer(t, "pod-b", "node-2")
	urls := map[string]string{"ip-a": podA.URL, "ip-b": podB.URL}
	apiserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" || r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, "ok")
	}))
	defer apiserver.Close()

	var mu sync.Mutex
	peers, peersErr := []string{"ip-a", "ip-b"}, error(nil)
	endpoints := &fakeEndpoints{ready: map[string]bool{"ip-a": true, "ip-b": true}}

	cfg := config.Default()
	cfg.Internal.IntervalMs = 10
	cfg.Internal.TimeoutMs = 500
	m := New(Options{
		Config: cfg, Pod: "pod-a", Node: "node-1", PodIP: "ip-a",
		ServiceURL: podA.URL, // stands in for the Service
		PeersHost:  "peers",
		PodURL:     func(ip string) string { return urls[ip] },
		APIServer:  &kube.InCluster{URL: apiserver.URL, Token: func() (string, error) { return "test-token", nil }},
		Endpoints:  endpoints,
		Resolve: func(ctx context.Context, host string) ([]string, error) {
			mu.Lock()
			defer mu.Unlock()
			return peers, peersErr
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)

	ids := []string{"apiserver", "pod/ip-a/fresh", "pod/ip-b/fresh", "service/fresh", "service/keepalive"}
	waitFor(t, "every target to answer", func() bool {
		r := m.Report(false, time.Time{})
		for _, id := range ids {
			if tr := find(r, id); tr == nil || tr.State == "idle" {
				return false
			}
		}
		return true
	})

	r := m.Report(false, time.Time{})
	if r.Pod != "pod-a" || r.Node != "node-1" || r.PodIP != "ip-a" || r.IntervalMs != 10 || r.StartedAt == 0 {
		t.Errorf("report header = %+v", r)
	}
	if len(r.Targets) != len(ids) {
		t.Fatalf("got %d targets, want %d", len(r.Targets), len(ids))
	}
	for i, id := range ids {
		if r.Targets[i].ID != id {
			t.Errorf("target %d = %s, want %s (sorted by id)", i, r.Targets[i].ID, id)
		}
	}
	if ep := r.Endpoints; !ep.Watching || !ep.Synced || !ep.Connected || len(ep.Changes) != 1 || ep.Changes[0].T != 1000 {
		t.Errorf("endpoints = %+v", ep)
	}

	self, peer := find(r, "pod/ip-a/fresh"), find(r, "pod/ip-b/fresh")
	if !self.Self || peer.Self {
		t.Errorf("self flags: ip-a %v, ip-b %v", self.Self, peer.Self)
	}
	if peer.Kind != "pod" || peer.PodIP != "ip-b" || peer.Pod != "pod-b" || peer.Node != "node-2" || !peer.Active {
		t.Errorf("peer = %+v", peer)
	}
	if peer.InEndpoints == nil || !*peer.InEndpoints || peer.Last.InEndpoints == nil || !*peer.Last.InEndpoints {
		t.Errorf("peer must be tagged as in endpoints: %+v / %+v", peer.InEndpoints, peer.Last)
	}
	if api := find(r, "apiserver"); api.State != "ok" || api.InEndpoints != nil || api.Pod != "" {
		t.Errorf("apiserver = %+v", api)
	}
	if svc := find(r, "service/keepalive"); svc.State != "ok" || svc.Pod != "pod-a" || svc.Mode != "keepalive" {
		t.Errorf("service/keepalive = %+v", svc)
	}
	// One "pod" answers behind the fake Service, where 3 are expected: degraded once enough answers are in.
	waitFor(t, "service/fresh to be degraded", func() bool {
		return find(m.Report(false, time.Time{}), "service/fresh").State == "degraded"
	})
	if svc := find(m.Report(false, time.Time{}), "service/keepalive"); svc.State != "ok" {
		t.Errorf("a kept-alive connection reaches one pod by design and must not be degraded: %s", svc.State)
	}

	// Results are only included on request.
	if peer.Results != nil {
		t.Error("results included without being asked for")
	}
	if all := find(m.Report(true, time.Time{}), "pod/ip-b/fresh").Results; len(all) == 0 {
		t.Error("no results when asked for all")
	}
	if none := find(m.Report(true, time.Now().Add(time.Hour)), "pod/ip-b/fresh").Results; len(none) != 0 {
		t.Errorf("%d results after a time in the future", len(none))
	}

	// The report is what /api/internal sends: it must be JSON with the documented keys.
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Targets []map[string]any `json:"targets"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "kind", "mode", "url", "active", "inEndpoints", "state", "outageSince", "counters", "last", "incidents"} {
		if _, ok := decoded.Targets[0][key]; !ok {
			t.Errorf("target JSON has no %q: %s", key, raw)
		}
	}

	// The dangerous case: pod-b dies but is still in endpoints.
	podB.Close()
	waitFor(t, "the outage of pod-b", func() bool {
		tr := find(m.Report(false, time.Time{}), "pod/ip-b/fresh")
		return tr.State == "outage" && *tr.InEndpoints && tr.Pod == "pod-b"
	})
	// Then the endpoint is removed: dead and no longer in endpoints.
	endpoints.set("ip-b", false)
	waitFor(t, "the endpoint removal", func() bool {
		tr := find(m.Report(false, time.Time{}), "pod/ip-b/fresh")
		return tr.State == "outage" && !*tr.InEndpoints && tr.Last.InEndpoints != nil && !*tr.Last.InEndpoints
	})

	// DNS failing must not stop the probes of pods already known.
	mu.Lock()
	peersErr = errors.New("dns is down")
	mu.Unlock()
	m.refreshPeers(ctx)
	if r := m.Report(false, time.Time{}); r.PeerError != "dns is down" || !find(r, "pod/ip-b/fresh").Active {
		t.Errorf("peerError = %q, ip-b active = %v", r.PeerError, find(r, "pod/ip-b/fresh").Active)
	}

	// The pod leaves the headless Service: it stays in the report, inactive, with its history.
	mu.Lock()
	peers, peersErr = []string{"ip-a"}, nil
	mu.Unlock()
	m.refreshPeers(ctx)
	gone := find(m.Report(false, time.Time{}), "pod/ip-b/fresh")
	if gone == nil || gone.Active || gone.Counters.Outages != 1 {
		t.Errorf("gone pod = %+v", gone)
	}
	if in := gone.Incidents; len(in) != 1 || in[0].Type != "failing" || in[0].End == nil || in[0].Note != "the pod is gone" {
		t.Errorf("the outage of a pod that is gone must be ended, with a note: %+v", in)
	}
	requests := gone.Counters.Requests
	time.Sleep(50 * time.Millisecond)
	if after := find(m.Report(false, time.Time{}), "pod/ip-b/fresh").Counters.Requests; after > requests+1 {
		t.Errorf("a pod that left is still being probed: %d -> %d requests", requests, after)
	}

	// It comes back on the same IP: probed again, from a clean slate.
	mu.Lock()
	peers = []string{"ip-a", "ip-b"}
	mu.Unlock()
	m.refreshPeers(ctx)
	if back := find(m.Report(false, time.Time{}), "pod/ip-b/fresh"); !back.Active {
		t.Errorf("returned pod = %+v", back)
	}
}

func TestManagerHonoursDisabledTargets(t *testing.T) {
	pod := pingServer(t, "pod-a", "node-1")
	cfg := config.Default()
	cfg.Internal.IntervalMs = 10
	cfg.Internal.Targets.Service.Modes = []string{"fresh"}
	cfg.Internal.Targets.PodDirect.Enabled = false
	cfg.Internal.Targets.APIServer.Enabled = false
	m := New(Options{
		Config: cfg, ServiceURL: pod.URL, PeersHost: "peers",
		PodURL:    func(string) string { return pod.URL },
		APIServer: &kube.InCluster{URL: pod.URL, Token: func() (string, error) { return "", nil }},
		Resolve: func(context.Context, string) ([]string, error) {
			t.Error("peers resolved although pod-direct probes are disabled")
			return nil, nil
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)
	waitFor(t, "the service target", func() bool { return len(m.Report(false, time.Time{}).Targets) == 1 })
	time.Sleep(30 * time.Millisecond)
	r := m.Report(false, time.Time{})
	if len(r.Targets) != 1 || r.Targets[0].ID != "service/fresh" {
		t.Errorf("targets = %+v", r.Targets)
	}
	if r.Endpoints.Watching || r.Endpoints.Changes == nil {
		t.Errorf("endpoints without a watcher = %+v", r.Endpoints)
	}
}
