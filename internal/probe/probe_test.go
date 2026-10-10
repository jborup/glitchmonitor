// SPDX-License-Identifier: AGPL-3.0-or-later

package probe

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

const slow = 200 * time.Millisecond

func TestClassifyResponses(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		badBody bool
		latency time.Duration
		want    Class
	}{
		{"fast 200", 200, false, 5 * time.Millisecond, OK},
		{"exactly at the slow threshold", 200, false, slow, OK},
		{"over the slow threshold", 200, false, slow + time.Millisecond, Slow},
		{"503", 503, false, time.Millisecond, HTTP5xx},
		{"slow 503 is still 5xx", 503, false, time.Second, HTTP5xx},
		{"404", 404, false, time.Millisecond, HTTPOther},
		{"302", 302, false, time.Millisecond, HTTPOther},
		{"200 with the wrong body", 200, true, time.Millisecond, HTTPOther},
	}
	for _, tc := range cases {
		if got := Classify(tc.status, tc.badBody, tc.latency, slow, true, nil); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
	for _, c := range []Class{OK, Slow} {
		if c.Failure() {
			t.Errorf("%s must not count as a failure", c)
		}
	}
	for _, c := range []Class{HTTP5xx, HTTPOther, Timeout, TimeoutConnect, TimeoutResponse, ConnRefused, DNSError, TLSError, OtherError} {
		if !c.Failure() {
			t.Errorf("%s must count as a failure", c)
		}
	}
}

// probeOnce runs one real probe, so the error classes are tested against the
// errors the HTTP client really returns.
func probeOnce(t *testing.T, spec Spec) Result {
	t.Helper()
	if spec.Timeout == 0 {
		spec.Timeout = 2 * time.Second
	}
	spec.Slow = slow
	client, transport := newClient(spec, true)
	defer transport.CloseIdleConnections()
	return once(context.Background(), client, spec)
}

func TestClassifyRealErrors(t *testing.T) {
	t.Run("connection refused", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr := ln.Addr().String()
		ln.Close()
		if r := probeOnce(t, Spec{URL: "http://" + addr}); r.Class != ConnRefused {
			t.Errorf("got %s, want %s", r.Class, ConnRefused)
		}
	})

	t.Run("timeout after the request was sent", func(t *testing.T) {
		release := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
		defer srv.Close()
		defer close(release)
		r := probeOnce(t, Spec{URL: srv.URL, Timeout: 50 * time.Millisecond})
		if r.Class != TimeoutResponse || !r.Sent {
			t.Errorf("got %s (sent=%v), want %s with the request sent", r.Class, r.Sent, TimeoutResponse)
		}
	})

	t.Run("timeout before the connection opened", func(t *testing.T) {
		// A dialer that never completes stands in for a host that is powered off:
		// the opening packet gets no answer at all.
		blackhole := &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}}
		start := time.Now()
		r := once(context.Background(), &http.Client{Transport: blackhole},
			Spec{URL: "http://192.0.2.1:8080", Timeout: 50 * time.Millisecond, Slow: slow})
		if r.Class != TimeoutConnect || r.Sent {
			t.Errorf("got %s (sent=%v), want %s with nothing sent", r.Class, r.Sent, TimeoutConnect)
		}
		if time.Since(start) > time.Second {
			t.Errorf("took %v, the timeout was 50 ms", time.Since(start))
		}
	})

	t.Run("the connect timeout applies before the request timeout", func(t *testing.T) {
		// 192.0.2.0/24 is reserved for documentation (RFC 5737) and routes nowhere.
		spec := Spec{URL: "http://192.0.2.1:8080", Timeout: 5 * time.Second, ConnectTimeout: 100 * time.Millisecond, Slow: slow}
		client, transport := newClient(spec, true)
		defer transport.CloseIdleConnections()
		start := time.Now()
		r := once(context.Background(), client, spec)
		elapsed := time.Since(start)
		if r.Class != TimeoutConnect {
			t.Skipf("this network answers for an unroutable address (%s after %v)", r.Class, elapsed)
		}
		if r.Sent || elapsed > 2*time.Second {
			t.Errorf("sent=%v after %v: the connect timeout of 100 ms did not apply", r.Sent, elapsed)
		}
	})

	t.Run("dns error", func(t *testing.T) {
		// .invalid is reserved and never resolves (RFC 2606).
		if r := probeOnce(t, Spec{URL: "http://glitchmonitor.invalid:8080"}); r.Class != DNSError {
			t.Errorf("got %s, want %s", r.Class, DNSError)
		}
	})

	t.Run("tls error", func(t *testing.T) {
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		defer srv.Close()
		// The test server's certificate is not signed by a trusted authority.
		if r := probeOnce(t, Spec{URL: srv.URL}); r.Class != TLSError {
			t.Errorf("got %s, want %s", r.Class, TLSError)
		}
	})

	t.Run("the status code is kept", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusGatewayTimeout) }))
		defer srv.Close()
		r := probeOnce(t, Spec{URL: srv.URL})
		if r.Class != HTTP5xx || r.Status != 504 || r.Label() != "http_504" || !r.Sent {
			t.Errorf("got %s status %d label %s sent=%v", r.Class, r.Status, r.Label(), r.Sent)
		}
		if got := (Result{Class: Timeout}).Label(); got != Timeout {
			t.Errorf("label of a timeout = %s", got)
		}
	})

	t.Run("answer with identity", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, `{"pod":"pod-a","node":"node-1"}`)
		}))
		defer srv.Close()
		r := probeOnce(t, Spec{URL: srv.URL, Parse: ParsePing})
		if r.Class != OK || r.Status != 200 || r.Pod != "pod-a" || r.Node != "node-1" || r.Latency <= 0 {
			t.Errorf("got %+v", r)
		}
	})

	t.Run("200 that is not a ping answer", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, "<html>some other app</html>")
		}))
		defer srv.Close()
		if r := probeOnce(t, Spec{URL: srv.URL, Parse: ParsePing}); r.Class != HTTPOther {
			t.Errorf("got %s, want %s", r.Class, HTTPOther)
		}
	})
}

// ---- tracker: the same cases as web/test/tracker.test.mjs ----

var (
	t0   = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	pods = []string{"pod-a", "pod-b", "pod-c"}
	opts = TrackerOptions{FailThreshold: 1, ExpectedReplicas: 3, PodWindow: 5 * time.Second}
)

func at(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }

type item struct {
	class Class
	pod   string // empty: rotate over pods
}

// feed records one result every 100 ms starting at fromMs and returns all events.
func feed(tr *Tracker, fromMs int, items ...item) []Event {
	var events []Event
	for i, it := range items {
		pod := it.pod
		if pod == "" {
			pod = pods[i%len(pods)]
		}
		events = append(events, tr.Record(Result{T: at(fromMs + i*100), Class: it.class, Pod: pod})...)
	}
	return events
}

func times(n int, it item) []item {
	items := make([]item, n)
	for i := range items {
		items[i] = it
	}
	return items
}

func types(events []Event) []EventType {
	out := []EventType{}
	for _, e := range events {
		out = append(out, e.Type)
	}
	return out
}

func wantTypes(t *testing.T, events []Event, want ...EventType) {
	t.Helper()
	if want == nil {
		want = []EventType{}
	}
	if got := types(events); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

func wantState(t *testing.T, tr *Tracker, want string) {
	t.Helper()
	if got, _ := tr.State(); got != want {
		t.Errorf("state = %s, want %s", got, want)
	}
}

func TestTrackerHealthy(t *testing.T) {
	tr := NewTracker(opts)
	wantState(t, tr, "idle")
	wantTypes(t, feed(tr, 1000, times(60, item{class: OK})...))
	wantState(t, tr, "ok")
	if want := (Counters{Requests: 60}); tr.Counters != want {
		t.Errorf("counters = %+v, want %+v", tr.Counters, want)
	}
}

func TestTrackerOutage(t *testing.T) {
	tr := NewTracker(opts)
	feed(tr, 0, times(30, item{class: OK})...)

	start := feed(tr, 3000, item{class: Timeout})
	wantTypes(t, start, OutageStart)
	if !start[0].T.Equal(at(3000)) {
		t.Errorf("outage start = %v, want %v", start[0].T, at(3000))
	}
	if state, since := tr.State(); state != "outage" || !since.Equal(at(3000)) {
		t.Errorf("state = %s since %v", state, since)
	}

	wantTypes(t, feed(tr, 3100, item{class: Timeout}, item{class: HTTP5xx}, item{class: HTTP5xx}))
	end := feed(tr, 3400, item{class: OK, pod: "pod-a"})
	wantTypes(t, end, OutageEnd)
	e := end[0]
	if !e.T.Equal(at(3400)) || !e.StartedAt.Equal(at(3000)) || e.Duration != 400*time.Millisecond || e.Failures != 4 {
		t.Errorf("outage end = %+v", e)
	}
	if want := (map[Class]int{Timeout: 2, HTTP5xx: 2}); !reflect.DeepEqual(e.Classes, want) {
		t.Errorf("classes = %v, want %v", e.Classes, want)
	}
	wantState(t, tr, "ok")
	want := Counters{Requests: 35, Failures: 4, Outages: 1, DowntimeMs: 400, LongestOutageMs: 400}
	if tr.Counters != want {
		t.Errorf("counters = %+v, want %+v", tr.Counters, want)
	}
}

func TestTrackerAccumulatesOutages(t *testing.T) {
	tr := NewTracker(opts)
	feed(tr, 0, item{class: OK}, item{class: ConnRefused}, item{class: OK},
		item{class: Timeout}, item{class: Timeout}, item{class: Timeout}, item{class: OK})
	if c := tr.Counters; c.Outages != 2 || c.DowntimeMs != 400 || c.LongestOutageMs != 300 {
		t.Errorf("counters = %+v", c)
	}
}

func TestTrackerFailThreshold(t *testing.T) {
	o := opts
	o.FailThreshold = 3
	tr := NewTracker(o)
	feed(tr, 0, times(5, item{class: OK})...)

	wantTypes(t, feed(tr, 500, item{class: Timeout}, item{class: Timeout}))
	wantState(t, tr, "failing")
	blip := feed(tr, 700, item{class: OK})
	wantTypes(t, blip, Blip)
	if b := blip[0]; !b.StartedAt.Equal(at(500)) || b.Duration != 200*time.Millisecond || b.Failures != 2 || b.Classes[Timeout] != 2 {
		t.Errorf("blip = %+v", b)
	}
	if tr.Counters.Outages != 0 || tr.Counters.Failures != 2 || tr.Counters.DowntimeMs != 0 {
		t.Errorf("a blip is not an outage: counters = %+v", tr.Counters)
	}

	events := feed(tr, 800, append(times(4, item{class: Timeout}), item{class: OK})...)
	wantTypes(t, events, OutageStart, OutageEnd)
	if !events[0].T.Equal(at(800)) || !events[0].DetectedAt.Equal(at(1000)) {
		t.Errorf("outage start = %+v", events[0])
	}
	if events[1].Duration != 400*time.Millisecond || events[1].Failures != 4 {
		t.Errorf("outage end = %+v", events[1])
	}
}

func TestTrackerSlow(t *testing.T) {
	tr := NewTracker(opts)
	feed(tr, 0, item{class: OK}, item{class: Slow})
	wantState(t, tr, "slow")
	if tr.Counters.Failures != 0 {
		t.Error("slow must not count as a failure")
	}
}

func TestTrackerDegraded(t *testing.T) {
	onlyA := item{class: OK, pod: "pod-a"}
	twoPods := func(n int) []item {
		items := make([]item, n)
		for i := range items {
			items[i] = item{class: OK, pod: pods[i%2]}
		}
		return items
	}

	t.Run("not judged before the window holds enough answers", func(t *testing.T) {
		tr := NewTracker(opts)
		wantTypes(t, feed(tr, 0, times(23, onlyA)...))
		wantState(t, tr, "ok")
		wantTypes(t, feed(tr, 2300, onlyA), DegradedStart)
	})

	t.Run("starts when a pod drops out of the window and ends when it is back", func(t *testing.T) {
		tr := NewTracker(opts)
		wantTypes(t, feed(tr, 0, times(60, item{class: OK})...))
		// pod-c stops answering at t=6000; its last answer (t=5900) leaves the 5 s window at t=10900.
		events := feed(tr, 6000, twoPods(60)...)
		wantTypes(t, events, DegradedStart)
		if !events[0].T.Equal(at(10900)) || !reflect.DeepEqual(events[0].Pods, []string{"pod-a", "pod-b"}) {
			t.Errorf("degraded start = %+v", events[0])
		}
		wantState(t, tr, "degraded")
		if tr.Counters.Failures != 0 {
			t.Error("degraded is not failure")
		}
		back := feed(tr, 12000, item{class: OK, pod: "pod-d"})
		wantTypes(t, back, DegradedEnd)
		if back[0].Duration != 1100*time.Millisecond {
			t.Errorf("degraded end = %+v", back[0])
		}
		wantState(t, tr, "ok")
	})

	t.Run("an outage ends the degraded period and takes over", func(t *testing.T) {
		tr := NewTracker(opts)
		feed(tr, 0, times(30, onlyA)...)
		wantState(t, tr, "degraded")
		wantTypes(t, feed(tr, 3000, item{class: Timeout}), DegradedEnd, OutageStart)
		wantState(t, tr, "outage")
	})

	t.Run("after an outage the pods are judged afresh", func(t *testing.T) {
		tr := NewTracker(opts)
		feed(tr, 0, times(30, item{class: OK})...)
		feed(tr, 3000, item{class: Timeout})
		events := feed(tr, 3100, twoPods(30)...)
		wantTypes(t, events, OutageEnd, DegradedStart)
		if !events[1].T.Equal(at(3100 + 23*100)) {
			t.Errorf("degraded start = %v", events[1].T)
		}
	})

	t.Run("one expected replica is never degraded", func(t *testing.T) {
		o := opts
		o.ExpectedReplicas = 1
		wantTypes(t, feed(NewTracker(o), 0, times(100, onlyA)...))
	})
}

func TestReorderDeliversInSendOrder(t *testing.T) {
	var got []string
	o := NewReorder(func(r Result) { got = append(got, r.Pod) })
	o.Push(2, Result{Pod: "b"})
	o.Push(4, Result{Pod: "d"})
	if len(got) != 0 {
		t.Fatalf("delivered %v before result 1 arrived", got)
	}
	o.Push(1, Result{Pod: "a"})
	o.Push(3, Result{Pod: "c"})
	if want := []string{"a", "b", "c", "d"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func newTestTarget(ring int) *Target {
	return NewTarget(TrackerOptions{FailThreshold: 3, ExpectedReplicas: 1, PodWindow: time.Second}, ring)
}

func TestTargetSnapshot(t *testing.T) {
	target := newTestTarget(4)
	if s := target.Snapshot(true, time.Time{}); s.State != "idle" || s.Last != nil || len(s.Incidents) != 0 || s.Incidents == nil {
		t.Errorf("empty snapshot = %+v", s)
	}

	yes := true
	target.Apply(Result{T: at(0), Class: OK, Latency: 1500 * time.Microsecond, Pod: "pod-a", Node: "node-1", InEndpoints: &yes})
	for i := 1; i <= 3; i++ {
		target.Apply(Result{T: at(i * 100), Class: ConnRefused})
	}

	s := target.Snapshot(false, time.Time{})
	if s.State != "outage" || s.OutageSince == nil || *s.OutageSince != at(100).UnixMilli() {
		t.Errorf("state = %s since %v", s.State, s.OutageSince)
	}
	if s.Pod != "pod-a" || s.Node != "node-1" {
		t.Errorf("the last known identity must survive failures: %q on %q", s.Pod, s.Node)
	}
	if s.Results != nil {
		t.Error("results must only be included when asked for")
	}

	target.Apply(Result{T: at(400), Class: OK, Latency: time.Millisecond, Pod: "pod-b", Node: "node-2"})
	s = target.Snapshot(true, time.Time{})
	if s.State != "ok" || s.Counters.Outages != 1 || s.Last.Pod != "pod-b" {
		t.Errorf("snapshot = %+v", s)
	}
	// The ring holds 4 results; 5 were applied, so the first is gone.
	if len(s.Results) != 4 || s.Results[0].T != at(100).UnixMilli() || s.Results[3].T != at(400).UnixMilli() {
		t.Errorf("results = %+v", s.Results)
	}
	if since := target.Snapshot(true, at(200)).Results; len(since) != 2 || since[0].T != at(300).UnixMilli() {
		t.Errorf("results since = %+v", since)
	}
}

// A target that fails on and off, as when one of several backends is dead,
// must be one incident from its first failure to its last, not one per failure.
func TestTargetGroupsFlickeringFailuresIntoOneIncident(t *testing.T) {
	target := newTestTarget(8)
	target.Apply(Result{T: at(0), Class: OK})
	if in := target.Snapshot(false, time.Time{}).Incidents; len(in) != 0 {
		t.Fatalf("incidents before any failure = %+v", in)
	}

	// The start is reported with the very first failure.
	target.Apply(Result{T: at(1000), Class: Timeout})
	in := target.Snapshot(false, time.Time{}).Incidents
	if len(in) != 1 || in[0].Type != "failing" || in[0].Start != at(1000).UnixMilli() || in[0].End != nil || in[0].Failures != 1 {
		t.Fatalf("running incident = %+v", in)
	}

	// One request in three fails for a minute: still the same incident.
	last := 0
	for ms := 1200; ms <= 61_000; ms += 200 {
		class := OK
		if (ms/200)%3 == 0 {
			class, last = Timeout, ms
		}
		target.Apply(Result{T: at(ms), Class: class})
	}
	// Then two failures in a row, of another kind.
	target.Apply(Result{T: at(61_200), Class: ConnRefused})
	target.Apply(Result{T: at(61_400), Class: ConnRefused})
	target.Apply(Result{T: at(61_600), Class: OK})
	in = target.Snapshot(false, time.Time{}).Incidents
	if len(in) != 1 || in[0].End != nil {
		t.Fatalf("after a minute of flicker: %+v", in)
	}
	_ = last

	// Quiet for less than EpisodeQuiet: still running. After it: ended, at the recovery.
	target.Apply(Result{T: at(61_600 + int(EpisodeQuiet.Milliseconds()) - 300), Class: OK})
	if in = target.Snapshot(false, time.Time{}).Incidents; in[0].End != nil {
		t.Fatalf("ended before the quiet time had passed: %+v", in[0])
	}
	target.Apply(Result{T: at(61_400 + int(EpisodeQuiet.Milliseconds()) + 100), Class: OK})
	in = target.Snapshot(false, time.Time{}).Incidents
	if len(in) != 1 {
		t.Fatalf("incidents = %+v", in)
	}
	got := in[0]
	if got.End == nil || *got.End != at(61_600).UnixMilli() || *got.DurationMs != 60_600 {
		t.Errorf("end = %v, duration = %v; want the first answer after the last failure", got.End, got.DurationMs)
	}
	if got.Failures != 103 || got.Classes[Timeout] != 101 || got.Classes[ConnRefused] != 2 || got.LongestRun != 2 {
		t.Errorf("failures = %d %v, longest run %d", got.Failures, got.Classes, got.LongestRun)
	}
	// 1000 ms to 61400 ms inclusive at 200 ms steps.
	if got.Requests != 303 {
		t.Errorf("requests = %d, want 303", got.Requests)
	}

	// A new failure after the quiet time is a new incident.
	target.Apply(Result{T: at(100_000), Class: Timeout})
	if in = target.Snapshot(false, time.Time{}).Incidents; len(in) != 2 || in[1].End != nil || in[1].Start != at(100_000).UnixMilli() {
		t.Errorf("incidents = %+v", in)
	}
}

func TestTargetRetireEndsWhatIsRunning(t *testing.T) {
	target := newTestTarget(4)
	target.Apply(Result{T: at(0), Class: Timeout})
	target.Apply(Result{T: at(100), Class: OK})
	target.Apply(Result{T: at(20_000), Class: OK}) // ends the first incident
	target.Apply(Result{T: at(20_200), Class: ConnRefused})
	target.Retire(at(20_900), "the pod is gone")
	in := target.Snapshot(false, time.Time{}).Incidents
	if len(in) != 2 {
		t.Fatalf("incidents = %+v", in)
	}
	if in[0].Note != "" || *in[0].DurationMs != 100 {
		t.Errorf("an incident that had ended must be left alone: %+v", in[0])
	}
	if in[1].End == nil || *in[1].End != at(20_900).UnixMilli() || *in[1].DurationMs != 700 || in[1].Note != "the pod is gone" {
		t.Errorf("running incident after retire = %+v", in[1])
	}
	target.Apply(Result{T: at(21_000), Class: OK})
	if again := target.Snapshot(false, time.Time{}).Incidents; len(again) != 2 {
		t.Errorf("a retired incident came back: %+v", again)
	}
}

func TestTargetKeepsOnlyRecentIncidents(t *testing.T) {
	target := newTestTarget(4)
	step := int(EpisodeQuiet.Milliseconds()) + 1000
	for i := range maxIncidents + 5 {
		target.Apply(Result{T: at(i * step), Class: Timeout})
		target.Apply(Result{T: at(i*step + 100), Class: OK})
	}
	target.Apply(Result{T: at((maxIncidents + 5) * step), Class: OK})
	s := target.Snapshot(false, time.Time{})
	if len(s.Incidents) != maxIncidents || s.Incidents[0].Start != at(5*step).UnixMilli() {
		t.Errorf("%d incidents, first at %d", len(s.Incidents), s.Incidents[0].Start)
	}
}

// Run against a server that fails for a while: the target must see one outage.
func TestRunDetectsAnOutage(t *testing.T) {
	var failing atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failing.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, `{"pod":"pod-a","node":"node-1"}`)
	}))
	defer srv.Close()

	for _, fresh := range []bool{false, true} {
		t.Run(fmt.Sprintf("fresh=%v", fresh), func(t *testing.T) {
			failing.Store(false)
			target := NewTarget(TrackerOptions{FailThreshold: 1, ExpectedReplicas: 1, PodWindow: time.Second}, 1000)
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				Run(ctx, Spec{
					URL: srv.URL, Interval: 10 * time.Millisecond, Timeout: time.Second, Slow: slow,
					Fresh: fresh, Parse: ParsePing,
				}, target)
				close(done)
			}()
			waitFor(t, "an answer", func() bool { return target.Snapshot(false, time.Time{}).State == "ok" })
			failing.Store(true)
			waitFor(t, "the outage", func() bool { return target.Snapshot(false, time.Time{}).State == "outage" })
			failing.Store(false)
			waitFor(t, "recovery", func() bool { return target.Snapshot(false, time.Time{}).State == "ok" })
			cancel()
			<-done

			s := target.Snapshot(true, time.Time{})
			if s.Counters.Outages != 1 || len(s.Incidents) != 1 || s.Incidents[0].Type != "failing" || s.Incidents[0].Classes["http_503"] == 0 {
				t.Errorf("counters = %+v, incidents = %+v", s.Counters, s.Incidents)
			}
			if s.Pod != "pod-a" || s.Last == nil || len(s.Results) < 3 {
				t.Errorf("snapshot = %+v", s)
			}
		})
	}
}

func TestTargetSpark(t *testing.T) {
	target := newTestTarget(100)
	base := time.Unix(1_800_000_000, 0)
	add := func(sec, ms int, class Class, latency time.Duration) *Result {
		r := Result{T: base.Add(time.Duration(sec)*time.Second + time.Duration(ms)*time.Millisecond), Class: class, Latency: latency}
		return &r
	}
	target.Apply(*add(0, 0, OK, 9*time.Millisecond)) // before the window
	target.Apply(*add(6, 100, OK, 1500*time.Microsecond))
	target.Apply(*add(6, 300, OK, 4250*time.Microsecond))
	target.Apply(*add(7, 0, TimeoutConnect, 500*time.Millisecond))
	recovered := add(7, 200, TimeoutConnect, 500*time.Millisecond)
	recovered.Retry = &Attempt{Class: OK}
	target.Apply(*recovered)
	target.Apply(*add(9, 900, Slow, 250*time.Millisecond))

	s := target.Spark(base.Add(9*time.Second+950*time.Millisecond), 5)
	if s.Start != base.Unix()+5 {
		t.Errorf("start = %d, want %d", s.Start, base.Unix()+5)
	}
	if want := []float64{-1, 4.2, -1, -1, 250}; !reflect.DeepEqual(s.LatencyMs, want) {
		t.Errorf("latencyMs = %v, want %v (a failure's time-to-fail is not a latency)", s.LatencyMs, want)
	}
	if want := []int{0, 2, 2, 0, 1}; !reflect.DeepEqual(s.Requests, want) {
		t.Errorf("requests = %v, want %v", s.Requests, want)
	}
	if want := []int{0, 0, 2, 0, 0}; !reflect.DeepEqual(s.Failures, want) {
		t.Errorf("failures = %v, want %v", s.Failures, want)
	}
	if want := []int{0, 0, 1, 0, 0}; !reflect.DeepEqual(s.Recovered, want) {
		t.Errorf("recovered = %v, want %v", s.Recovered, want)
	}
}

// With retry on, a failed probe is tried once more on a new connection. The
// first attempt is still what counts; the retry tells what a retrying client gets.
func TestRunRetriesOnce(t *testing.T) {
	var n atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Every third request fails, as when one of three backends is dead.
		if n.Add(1)%3 == 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, `{"pod":"pod-a","node":"node-1"}`)
	}))
	defer srv.Close()

	target := NewTarget(TrackerOptions{FailThreshold: 3, ExpectedReplicas: 1, PodWindow: time.Second}, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Run(ctx, Spec{URL: srv.URL, Interval: 10 * time.Millisecond, Timeout: time.Second, Slow: slow, Parse: ParsePing, Retry: true}, target)
		close(done)
	}()
	waitFor(t, "some recovered failures", func() bool { return target.Snapshot(false, time.Time{}).Counters.Recovered >= 3 })
	cancel()
	<-done

	s := target.Snapshot(true, time.Time{})
	if s.Counters.Failures == 0 || s.Counters.Outages != 0 {
		t.Errorf("counters = %+v: the first attempt must still count as a failure, and none of this is an outage", s.Counters)
	}
	var failed, recovered int
	for _, r := range s.Results {
		if !r.Class.Failure() {
			if r.Retry != nil {
				t.Fatalf("an answered probe was retried: %+v", r)
			}
			continue
		}
		failed++
		if r.Status != 503 || !r.Sent || r.Retry == nil {
			t.Fatalf("failed result = %+v, want status 503, sent, with a retry", r)
		}
		if !r.Retry.Class.Failure() {
			recovered++
		}
	}
	if failed == 0 || recovered == 0 {
		t.Errorf("%d failed, %d recovered on retry", failed, recovered)
	}
	in := s.Incidents[len(s.Incidents)-1]
	if in.Type != "failing" || in.Recovered == 0 || in.Sent != in.Failures || in.Classes["http_503"] != in.Failures || in.LastFailure == 0 {
		t.Errorf("incident = %+v", in)
	}
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
