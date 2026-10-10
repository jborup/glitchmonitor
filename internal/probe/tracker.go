// SPDX-License-Identifier: AGPL-3.0-or-later

package probe

import (
	"slices"
	"strconv"
	"time"
)

// DegradedSamplesPerReplica: "degraded" is only judged once the window holds
// this many answers per expected replica. With fewer, a pod can be missing
// from the window by chance.
const DegradedSamplesPerReplica = 8

// Result is one probe, stamped with the time it was sent.
type Result struct {
	T       time.Time
	Class   Class
	Latency time.Duration // zero for a failure
	Status  int           // the HTTP status, when a response arrived
	// Sent: the request had been written to the connection. For a failure this
	// is what decides whether trying again is safe.
	Sent bool
	Pod  string // who answered, when the target says so
	Node string
	// Retry is the second attempt, made on a new connection after a failure
	// when the probe is set to retry; nil otherwise.
	Retry *Attempt
	// InEndpoints: for a pod probed directly, whether it was a ready endpoint
	// of the Service when the probe was sent; nil when not known or not applicable.
	InEndpoints *bool
}

// Attempt is the outcome of a retry.
type Attempt struct {
	Class   Class
	Status  int
	Latency time.Duration // from the start of the retry
}

// Recovered reports whether the request failed and its retry succeeded.
func (r Result) Recovered() bool {
	return r.Class.Failure() && r.Retry != nil && !r.Retry.Class.Failure()
}

// Label is the class with the exact status for HTTP failures, such as
// "http_503": what the log counts failures by.
func (r Result) Label() Class {
	if (r.Class == HTTP5xx || r.Class == HTTPOther) && r.Status != 0 {
		return Class("http_" + strconv.Itoa(r.Status))
	}
	return r.Class
}

// Counters accumulate over the life of a tracker.
type Counters struct {
	Requests uint64 `json:"requests"`
	Failures uint64 `json:"failures"`
	// Recovered: failures whose retry on a new connection succeeded.
	Recovered       uint64 `json:"recovered"`
	Outages         uint64 `json:"outages"`
	DowntimeMs      int64  `json:"downtimeMs"`
	LongestOutageMs int64  `json:"longestOutageMs"`
}

// EventType names what a result caused.
type EventType string

const (
	OutageStart EventType = "outage_start"
	OutageEnd   EventType = "outage_end"
	// Blip: a run of failures that ended before it reached failThreshold.
	Blip          EventType = "blip"
	DegradedStart EventType = "degraded_start"
	DegradedEnd   EventType = "degraded_end"
)

// Event is returned by Record. T is when the state changed; for the two end
// events and for a blip, StartedAt and Duration describe the period that ended.
type Event struct {
	Type       EventType
	T          time.Time
	DetectedAt time.Time     // outage_start: the send time of the request that crossed failThreshold
	StartedAt  time.Time     // *_end
	Duration   time.Duration // *_end
	Failures   int           // outage_end, blip
	Classes    map[Class]int // outage_end, blip
	Pods       []string      // degraded_start: the pods still answering
}

// TrackerOptions mirror the browser's thresholds.
type TrackerOptions struct {
	FailThreshold    int           // consecutive failures that make an outage
	ExpectedReplicas int           // distinct pods expected to answer; 1 turns "degraded" off
	PodWindow        time.Duration // how far back "answered recently" looks
}

// Tracker is the outage and degraded state machine for one target. It is the
// same machine as web/static/lib/tracker.mjs. Results must be recorded in the
// order the requests were sent (see Reorder). Not safe for concurrent use.
type Tracker struct {
	opts       TrackerOptions
	minSamples int

	Counters Counters

	status      string // "idle", "up", "failing", "outage"
	streak      *streak
	degraded    *time.Time
	answers     []time.Time
	podLastSeen map[string]time.Time
	lastClass   Class
}

type streak struct {
	startedAt time.Time
	failures  int
	classes   map[Class]int
}

func NewTracker(opts TrackerOptions) *Tracker {
	return &Tracker{
		opts:        opts,
		minSamples:  opts.ExpectedReplicas * DegradedSamplesPerReplica,
		status:      "idle",
		podLastSeen: map[string]time.Time{},
	}
}

// Record applies one result and returns the events it caused. An outage runs
// from the send time of the first failed request to the send time of the
// first request that succeeded again.
func (tr *Tracker) Record(r Result) []Event {
	var events []Event
	c := &tr.Counters
	c.Requests++
	tr.lastClass = r.Class

	if r.Class.Failure() {
		c.Failures++
		if r.Recovered() {
			c.Recovered++
		}
		if tr.streak == nil {
			tr.streak = &streak{startedAt: r.T, classes: map[Class]int{}}
		}
		tr.streak.failures++
		tr.streak.classes[r.Label()]++
		if tr.status != "outage" {
			if tr.streak.failures >= tr.opts.FailThreshold {
				events = tr.endDegraded(tr.streak.startedAt, events)
				tr.status = "outage"
				c.Outages++
				events = append(events, Event{Type: OutageStart, T: tr.streak.startedAt, DetectedAt: r.T})
			} else {
				tr.status = "failing"
			}
		}
		return events
	}

	if tr.status == "outage" {
		s := tr.streak
		d := r.T.Sub(s.startedAt)
		c.DowntimeMs += d.Milliseconds()
		c.LongestOutageMs = max(c.LongestOutageMs, d.Milliseconds())
		events = append(events, Event{
			Type: OutageEnd, T: r.T, StartedAt: s.startedAt, Duration: d, Failures: s.failures, Classes: s.classes,
		})
		// Judge "degraded" afresh on what answers after the outage.
		tr.answers = nil
		clear(tr.podLastSeen)
	} else if s := tr.streak; s != nil {
		events = append(events, Event{
			Type: Blip, T: r.T, StartedAt: s.startedAt, Duration: r.T.Sub(s.startedAt), Failures: s.failures, Classes: s.classes,
		})
	}
	tr.streak = nil
	tr.status = "up"

	tr.answers = append(tr.answers, r.T)
	if r.Pod != "" {
		tr.podLastSeen[r.Pod] = r.T
	}
	pods := tr.podsInWindow(r.T)
	if tr.opts.ExpectedReplicas > 1 && len(tr.answers) >= tr.minSamples {
		if len(pods) < tr.opts.ExpectedReplicas {
			if tr.degraded == nil {
				t := r.T
				tr.degraded = &t
				events = append(events, Event{Type: DegradedStart, T: r.T, Pods: pods})
			}
		} else {
			events = tr.endDegraded(r.T, events)
		}
	}
	return events
}

func (tr *Tracker) endDegraded(t time.Time, events []Event) []Event {
	if tr.degraded == nil {
		return events
	}
	started := *tr.degraded
	tr.degraded = nil
	return append(events, Event{Type: DegradedEnd, T: t, StartedAt: started, Duration: t.Sub(started)})
}

// podsInWindow drops what has left the window ending at t and returns the
// distinct pods that answered inside it, sorted.
func (tr *Tracker) podsInWindow(t time.Time) []string {
	from := t.Add(-tr.opts.PodWindow)
	stale := 0
	for stale < len(tr.answers) && !tr.answers[stale].After(from) {
		stale++
	}
	tr.answers = tr.answers[stale:]
	pods := make([]string, 0, len(tr.podLastSeen))
	for pod, seen := range tr.podLastSeen {
		if !seen.After(from) {
			delete(tr.podLastSeen, pod)
			continue
		}
		pods = append(pods, pod)
	}
	slices.Sort(pods)
	return pods
}

// State is what a tile shows: "idle", "ok", "slow", "degraded", "failing" or
// "outage", and since when the outage has been running.
func (tr *Tracker) State() (state string, outageSince time.Time) {
	switch {
	case tr.status == "idle":
		return "idle", time.Time{}
	case tr.status == "outage":
		return "outage", tr.streak.startedAt
	case tr.status == "failing":
		return "failing", time.Time{}
	case tr.degraded != nil:
		return "degraded", time.Time{}
	case tr.lastClass == Slow:
		return "slow", time.Time{}
	}
	return "ok", time.Time{}
}
