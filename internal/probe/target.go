// SPDX-License-Identifier: AGPL-3.0-or-later

package probe

import (
	"maps"
	"sync"
	"time"
)

// maxIncidents is how many outages and degraded periods a target remembers.
const maxIncidents = 20

// EpisodeQuiet is how long a target must go without a failed request before a
// run of failures counts as over. Failures closer together than this are one
// episode, however much they flicker in between.
const EpisodeQuiet = 10 * time.Second

// Incident is something that happened to a target, as reported to the dashboard:
//
//   - "failing": an episode of failed requests. It starts with the first
//     failure and ends once EpisodeQuiet has passed without another, so a
//     target that keeps failing on and off is one incident, not hundreds.
//   - "degraded": fewer pods answered than expected.
//
// Times are epoch milliseconds; End and DurationMs are null while it runs.
type Incident struct {
	Type       string `json:"type"`
	Start      int64  `json:"start"`
	End        *int64 `json:"end"`
	DurationMs *int64 `json:"durationMs"`
	Failures   int    `json:"failures,omitempty"`   // failing: failed requests so far
	Requests   int    `json:"requests,omitempty"`   // failing: requests sent from the first failure to the last
	LongestRun int    `json:"longestRun,omitempty"` // failing: most failures in a row
	// failing: of the failures, how many succeeded when retried on a new
	// connection, and how many failed after the request had been sent (where
	// a retry may repeat something the server already did).
	Recovered   int           `json:"recovered,omitempty"`
	Sent        int           `json:"sent,omitempty"`
	LastFailure int64         `json:"lastFailure,omitempty"` // failing: when the latest failed request was sent
	Classes     map[Class]int `json:"classes,omitempty"`
	Pods        []string      `json:"pods,omitempty"` // degraded: the pods still answering
	Note        string        `json:"note,omitempty"` // why it ended, when not by itself
}

// episode is the "failing" incident that is still running.
type episode struct {
	start       time.Time
	lastFailure time.Time
	answered    time.Time // the first answer after the last failure
	failures    int
	recovered   int
	sent        int
	requests    int // all requests since start
	counted     int // requests up to and including the last failure
	run         int
	longestRun  int
	classes     map[Class]int
}

func (e *episode) incident(end time.Time, note string) Incident {
	in := Incident{
		Type: "failing", Start: e.start.UnixMilli(), Failures: e.failures, Requests: e.counted,
		LongestRun: e.longestRun, Classes: maps.Clone(e.classes), Note: note,
		Recovered: e.recovered, Sent: e.sent, LastFailure: e.lastFailure.UnixMilli(),
	}
	if !end.IsZero() {
		ms := end.UnixMilli()
		d := max(0, ms-in.Start)
		in.End, in.DurationMs = &ms, &d
	}
	return in
}

// ResultJSON is one probe result on the wire.
type ResultJSON struct {
	T         int64   `json:"t"`
	Class     Class   `json:"class"`
	LatencyMs float64 `json:"latencyMs"` // for a failure: how long until it failed
	Status    int     `json:"status,omitempty"`
	// Sent: for a failure, whether the request had been sent. If not, a retry
	// cannot have done anything twice.
	Sent        bool         `json:"sent,omitempty"`
	Pod         string       `json:"pod,omitempty"`
	Node        string       `json:"node,omitempty"`
	InEndpoints *bool        `json:"inEndpoints,omitempty"`
	Retry       *AttemptJSON `json:"retry,omitempty"`
}

// AttemptJSON is the retry of a failed probe.
type AttemptJSON struct {
	Class     Class   `json:"class"`
	Status    int     `json:"status,omitempty"`
	LatencyMs float64 `json:"latencyMs"`
}

func millis(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func resultJSON(r Result) ResultJSON {
	out := ResultJSON{
		T: r.T.UnixMilli(), Class: r.Class, LatencyMs: millis(r.Latency), Status: r.Status,
		Sent: r.Sent && r.Class.Failure(), Pod: r.Pod, Node: r.Node, InEndpoints: r.InEndpoints,
	}
	if r.Retry != nil {
		out.Retry = &AttemptJSON{Class: r.Retry.Class, Status: r.Retry.Status, LatencyMs: millis(r.Retry.Latency)}
	}
	return out
}

// Snapshot is the state of one target at one moment.
type Snapshot struct {
	State       string       `json:"state"`
	OutageSince *int64       `json:"outageSince"`
	Counters    Counters     `json:"counters"`
	Pod         string       `json:"pod,omitempty"` // who answered most recently
	Node        string       `json:"node,omitempty"`
	Last        *ResultJSON  `json:"last"`
	Incidents   []Incident   `json:"incidents"`
	Results     []ResultJSON `json:"results,omitempty"`
}

// Target holds everything measured about one probe target: the state machine,
// a ring of recent results and the recent incidents. Safe for concurrent use.
type Target struct {
	mu        sync.Mutex
	tracker   *Tracker
	ring      []Result
	next      int // where the next result goes
	count     int
	incidents []Incident // those that have ended, and a running "degraded"
	failing   *episode   // the running "failing" incident, if any
	last      *Result
	pod, node string
}

func NewTarget(opts TrackerOptions, ringSize int) *Target {
	return &Target{tracker: NewTracker(opts), ring: make([]Result, ringSize)}
}

// Apply records one result. Results must arrive in send order.
func (t *Target) Apply(r Result) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.ring[t.next] = r
	t.next = (t.next + 1) % len(t.ring)
	t.count = min(t.count+1, len(t.ring))
	t.last = &r
	if r.Pod != "" {
		t.pod, t.node = r.Pod, r.Node
	}
	t.follow(r)
	for _, e := range t.tracker.Record(r) {
		switch e.Type {
		case DegradedStart:
			t.open(Incident{Type: "degraded", Start: e.T.UnixMilli(), Pods: e.Pods})
		case DegradedEnd:
			t.close("degraded", e)
		}
	}
}

// follow keeps the running episode of failures up to date with one result.
func (t *Target) follow(r Result) {
	ep := t.failing
	// Quiet for long enough: what came before is over, whatever comes now.
	if ep != nil && !ep.answered.IsZero() && r.T.Sub(ep.lastFailure) > EpisodeQuiet {
		t.open(ep.incident(ep.answered, ""))
		t.failing, ep = nil, nil
	}
	if r.Class.Failure() {
		if ep == nil {
			ep = &episode{start: r.T, classes: map[Class]int{}}
			t.failing = ep
		}
		ep.requests++
		ep.failures++
		ep.run++
		ep.longestRun = max(ep.longestRun, ep.run)
		ep.classes[r.Label()]++
		if r.Recovered() {
			ep.recovered++
		}
		if r.Sent {
			ep.sent++
		}
		ep.lastFailure, ep.counted, ep.answered = r.T, ep.requests, time.Time{}
		return
	}
	if ep == nil {
		return
	}
	ep.requests++
	ep.run = 0
	if ep.answered.IsZero() {
		ep.answered = r.T
	}
}

func (t *Target) open(in Incident) {
	t.incidents = append(t.incidents, in)
	if len(t.incidents) > maxIncidents {
		t.incidents = t.incidents[len(t.incidents)-maxIncidents:]
	}
}

func (t *Target) close(kind string, e Event) {
	for i := len(t.incidents) - 1; i >= 0; i-- {
		in := &t.incidents[i]
		if in.Type != kind || in.End != nil {
			continue
		}
		end, d := e.T.UnixMilli(), e.Duration.Milliseconds()
		in.End, in.DurationMs = &end, &d
		return
	}
}

// Spark is a small per-second history of one target, for a mini graph.
// Bucket i covers the second Start+i.
type Spark struct {
	Start     int64     `json:"start"`     // epoch seconds of the first bucket
	LatencyMs []float64 `json:"latencyMs"` // slowest answer in that second; -1 when nothing answered
	Requests  []int     `json:"requests"`  // requests sent in that second
	Failures  []int     `json:"failures"`  // of those, how many failed
	Recovered []int     `json:"recovered"` // of the failures, how many succeeded on a retry
}

// Spark summarises the last `seconds` seconds up to now from the ring of results.
func (t *Target) Spark(now time.Time, seconds int) Spark {
	s := Spark{
		Start: now.Unix() - int64(seconds) + 1, LatencyMs: make([]float64, seconds),
		Requests: make([]int, seconds), Failures: make([]int, seconds), Recovered: make([]int, seconds),
	}
	for i := range s.LatencyMs {
		s.LatencyMs[i] = -1
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := range t.count {
		r := t.ring[(t.next-1-i+2*len(t.ring))%len(t.ring)] // newest first
		b := r.T.Unix() - s.Start
		if b < 0 {
			break
		}
		if b >= int64(seconds) {
			continue
		}
		s.Requests[b]++
		if r.Class.Failure() {
			s.Failures[b]++
			if r.Recovered() {
				s.Recovered[b]++
			}
			continue
		}
		ms := float64(r.Latency.Microseconds()/100) / 10
		s.LatencyMs[b] = max(s.LatencyMs[b], ms)
	}
	return s
}

// Retire ends whatever is still running when a target stops being probed, such
// as a pod that has been deleted: its outage did not end, the target did.
func (t *Target) Retire(at time.Time, note string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := range t.incidents {
		in := &t.incidents[i]
		if in.End != nil {
			continue
		}
		end := at.UnixMilli()
		d := max(0, end-in.Start)
		in.End, in.DurationMs, in.Note = &end, &d, note
	}
	if t.failing != nil {
		t.open(t.failing.incident(at, note))
		t.failing = nil
	}
}

// Snapshot returns the current state. With results, it includes the results
// in the ring that were sent after since, oldest first.
func (t *Target) Snapshot(withResults bool, since time.Time) Snapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	state, outageSince := t.tracker.State()
	s := Snapshot{
		State:     state,
		Counters:  t.tracker.Counters,
		Pod:       t.pod,
		Node:      t.node,
		Incidents: append([]Incident{}, t.incidents...),
	}
	if t.failing != nil {
		s.Incidents = append(s.Incidents, t.failing.incident(time.Time{}, ""))
	}
	if !outageSince.IsZero() {
		ms := outageSince.UnixMilli()
		s.OutageSince = &ms
	}
	if t.last != nil {
		last := resultJSON(*t.last)
		s.Last = &last
	}
	if withResults {
		start := (t.next - t.count + len(t.ring)) % len(t.ring)
		for i := range t.count {
			if r := t.ring[(start+i)%len(t.ring)]; r.T.After(since) {
				s.Results = append(s.Results, resultJSON(r))
			}
		}
	}
	return s
}
