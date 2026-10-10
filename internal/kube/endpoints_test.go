// SPDX-License-Identifier: AGPL-3.0-or-later

package kube

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// slice renders an EndpointSlice with the given "ip=ready" endpoints.
func slice(name, version string, endpoints ...string) string {
	out := fmt.Sprintf(`{"metadata":{"name":%q,"resourceVersion":%q},"endpoints":[`, name, version)
	for i, ep := range endpoints {
		ip, ready, _ := strings.Cut(ep, "=")
		if i > 0 {
			out += ","
		}
		condition := fmt.Sprintf(`{"ready":%s}`, ready)
		if ready == "unset" {
			condition = `{}`
		}
		out += fmt.Sprintf(`{"addresses":[%q],"conditions":%s}`, ip, condition)
	}
	return out + "]}"
}

// fakeAPI serves one list and then the watch events sent on the channel.
type fakeAPI struct {
	t       *testing.T
	list    atomic.Value // string: the items of the list
	events  chan string
	lists   atomic.Int32
	failing atomic.Bool
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
		f.t.Errorf("Authorization = %q", got)
	}
	if want := "/apis/discovery.k8s.io/v1/namespaces/glitchmonitor/endpointslices"; r.URL.Path != want {
		f.t.Errorf("path = %q, want %q", r.URL.Path, want)
	}
	if got := r.URL.Query().Get("labelSelector"); got != "kubernetes.io/service-name=glitchmonitor" {
		f.t.Errorf("labelSelector = %q", got)
	}
	if f.failing.Load() {
		http.Error(w, "the API server is away", http.StatusServiceUnavailable)
		return
	}
	if r.URL.Query().Get("watch") == "" {
		f.lists.Add(1)
		fmt.Fprintf(w, `{"metadata":{"resourceVersion":"100"},"items":[%s]}`, f.list.Load())
		return
	}
	w.(http.Flusher).Flush()
	for {
		select {
		case ev, ok := <-f.events:
			if !ok {
				return
			}
			io.WriteString(w, ev+"\n")
			w.(http.Flusher).Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func startEndpoints(t *testing.T, items string) (*fakeAPI, *Endpoints) {
	t.Helper()
	api := &fakeAPI{t: t, events: make(chan string)}
	api.list.Store(items)
	srv := httptest.NewServer(api)
	e := NewEndpoints(&InCluster{URL: srv.URL, Token: func() (string, error) { return "test-token", nil }},
		"glitchmonitor", "glitchmonitor", slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done; srv.Close() })
	return api, e
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

func (e *Endpoints) is(ip string, want bool) func() bool {
	return func() bool {
		ready, known := e.Ready(ip)
		return known && ready == want
	}
}

func TestEndpointsFollowListAndWatch(t *testing.T) {
	api, e := startEndpoints(t, slice("s1", "90", "10.0.0.1=true", "10.0.0.2=false", "10.0.0.3=unset"))

	if _, known := e.Ready("10.0.0.1"); known {
		// Not an error if the list already arrived, but before it the state must be unknown.
		t.Log("list arrived before the first check")
	}
	waitFor(t, "the list", e.is("10.0.0.1", true))
	if !e.is("10.0.0.2", false)() {
		t.Error("an endpoint that is not ready must not count")
	}
	if !e.is("10.0.0.3", true)() {
		t.Error("an unset ready condition means ready")
	}
	if !e.is("10.0.0.9", false)() {
		t.Error("an unknown address is not an endpoint")
	}
	if synced, connected, changes := e.Status(); !synced || !connected || len(changes) != 0 {
		t.Errorf("after the first list: synced=%v connected=%v changes=%v", synced, connected, changes)
	}

	// 10.0.0.1 goes not-ready, 10.0.0.2 becomes ready.
	api.events <- fmt.Sprintf(`{"type":"MODIFIED","object":%s}`, slice("s1", "101", "10.0.0.1=false", "10.0.0.2=true", "10.0.0.3=true"))
	waitFor(t, "the modification", e.is("10.0.0.1", false))
	if !e.is("10.0.0.2", true)() {
		t.Error("10.0.0.2 should be ready now")
	}

	// A second slice adds an address; a bookmark changes nothing.
	api.events <- fmt.Sprintf(`{"type":"ADDED","object":%s}`, slice("s2", "102", "10.0.0.4=true"))
	api.events <- `{"type":"BOOKMARK","object":{"metadata":{"resourceVersion":"103"}}}`
	waitFor(t, "the added slice", e.is("10.0.0.4", true))

	// Deleting the first slice removes its addresses.
	api.events <- fmt.Sprintf(`{"type":"DELETED","object":%s}`, slice("s1", "104"))
	waitFor(t, "the deletion", e.is("10.0.0.2", false))
	if !e.is("10.0.0.4", true)() {
		t.Error("the other slice must be untouched")
	}

	_, _, changes := e.Status()
	got := map[string][]bool{}
	for _, c := range changes {
		got[c.IP] = append(got[c.IP], c.Ready)
	}
	want := map[string][]bool{
		"10.0.0.1": {false},
		"10.0.0.2": {true, false},
		"10.0.0.3": {false},
		"10.0.0.4": {true},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("changes = %v, want %v", got, want)
	}
}

func TestEndpointsRelistAfterAWatchError(t *testing.T) {
	api, e := startEndpoints(t, slice("s1", "90", "10.0.0.1=true"))
	waitFor(t, "the list", e.is("10.0.0.1", true))

	api.list.Store(slice("s1", "200", "10.0.0.5=true"))
	api.events <- `{"type":"ERROR","object":{"kind":"Status","code":410,"reason":"Expired"}}`
	waitFor(t, "the relist", e.is("10.0.0.5", true))
	if !e.is("10.0.0.1", false)() {
		t.Error("the relist must replace the old state")
	}
	if api.lists.Load() < 2 {
		t.Errorf("listed %d times, want at least 2", api.lists.Load())
	}
}

func TestEndpointsKeepLastStateWhileTheAPIServerIsAway(t *testing.T) {
	api, e := startEndpoints(t, slice("s1", "90", "10.0.0.1=true"))
	waitFor(t, "the list", e.is("10.0.0.1", true))

	api.failing.Store(true)
	close(api.events) // ends the running watch
	waitFor(t, "the disconnect", func() bool { _, connected, _ := e.Status(); return !connected })
	if !e.is("10.0.0.1", true)() {
		t.Error("the last known state must be kept while disconnected")
	}

	api.events = make(chan string)
	api.failing.Store(false)
	waitFor(t, "the reconnect", func() bool { _, connected, _ := e.Status(); return connected })
}
