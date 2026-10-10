// SPDX-License-Identifier: AGPL-3.0-or-later

// Outage and degraded state machine for one probe target. Pure logic: the
// caller feeds it results in the order the requests were SENT (see reorder.mjs)
// and gets back the events that result caused.

import { isFailure } from './classify.mjs';

// "Degraded" is only judged once the window holds this many answers per
// expected replica. With fewer, a pod can be missing from the window by chance.
export const DEGRADED_SAMPLES_PER_REPLICA = 8;

export function createCounters() {
  return { requests: 0, failures: 0, outages: 0, downtimeMs: 0, longestOutageMs: 0 };
}

export function createTracker({ failThreshold, expectedReplicas, podWindowMs }, counters = createCounters()) {
  return {
    failThreshold,
    expectedReplicas,
    podWindowMs,
    minSamples: expectedReplicas * DEGRADED_SAMPLES_PER_REPLICA,
    counters,
    status: 'idle',        // 'idle' | 'up' | 'failing' | 'outage'
    streak: null,          // current run of failures: { startedAt, failures, classes }
    degraded: null,        // { startedAt, pods } while fewer pods answer than expected
    answers: [],           // send times of the answers inside the pod window
    podLastSeen: new Map(),
    lastClass: null,
  };
}

// record applies one result { t, cls, pod } and returns the events it caused:
//   { type: 'outage_start', t, detectedAt }
//   { type: 'outage_end', t, startedAt, durationMs, failures, classes }
//   { type: 'degraded_start', t, pods }
//   { type: 'degraded_end', t, startedAt, durationMs }
// An outage runs from the send time of the first failed request to the send
// time of the first request that succeeded again, so its length is known to
// within one probe interval.
export function record(tr, { t, cls, pod }) {
  const events = [];
  const c = tr.counters;
  c.requests++;
  tr.lastClass = cls;

  if (isFailure(cls)) {
    c.failures++;
    if (!tr.streak) tr.streak = { startedAt: t, failures: 0, classes: {} };
    tr.streak.failures++;
    tr.streak.classes[cls] = (tr.streak.classes[cls] || 0) + 1;
    if (tr.status !== 'outage') {
      if (tr.streak.failures >= tr.failThreshold) {
        endDegraded(tr, tr.streak.startedAt, events);
        tr.status = 'outage';
        c.outages++;
        events.push({ type: 'outage_start', t: tr.streak.startedAt, detectedAt: t });
      } else {
        tr.status = 'failing';
      }
    }
    return events;
  }

  if (tr.status === 'outage') {
    const { startedAt, failures, classes } = tr.streak;
    const durationMs = t - startedAt;
    c.downtimeMs += durationMs;
    c.longestOutageMs = Math.max(c.longestOutageMs, durationMs);
    events.push({ type: 'outage_end', t, startedAt, durationMs, failures, classes });
    // Judge "degraded" afresh on what answers after the outage.
    tr.answers = [];
    tr.podLastSeen.clear();
  }
  tr.streak = null;
  tr.status = 'up';

  tr.answers.push(t);
  if (pod) tr.podLastSeen.set(pod, t);
  const pods = podsInWindow(tr, t);
  if (tr.answers.length >= tr.minSamples) {
    if (pods.length < tr.expectedReplicas) {
      if (!tr.degraded) {
        tr.degraded = { startedAt: t, pods };
        events.push({ type: 'degraded_start', t, pods });
      }
    } else {
      endDegraded(tr, t, events);
    }
  }
  return events;
}

function endDegraded(tr, t, events) {
  if (!tr.degraded) return;
  const { startedAt } = tr.degraded;
  tr.degraded = null;
  events.push({ type: 'degraded_end', t, startedAt, durationMs: t - startedAt });
}

// podsInWindow drops what has left the window ending at t and returns the
// distinct pods that answered inside it, sorted.
export function podsInWindow(tr, t) {
  const from = t - tr.podWindowMs;
  let stale = 0;
  while (stale < tr.answers.length && tr.answers[stale] <= from) stale++;
  if (stale) tr.answers.splice(0, stale);
  for (const [pod, seen] of tr.podLastSeen) {
    if (seen <= from) tr.podLastSeen.delete(pod);
  }
  return [...tr.podLastSeen.keys()].sort();
}

// podsAnswering counts the distinct pods seen in the window ending at now, without changing the tracker.
export function podsAnswering(tr, now) {
  let n = 0;
  for (const seen of tr.podLastSeen.values()) {
    if (seen > now - tr.podWindowMs) n++;
  }
  return n;
}

// view is what a tile shows at time now.
export function view(tr, now) {
  const outageMs = tr.status === 'outage' ? Math.max(0, now - tr.streak.startedAt) : null;
  let state = 'green';
  let label = 'ok';
  if (tr.status === 'idle') [state, label] = ['idle', 'waiting'];
  else if (tr.status === 'outage') [state, label] = ['red', 'outage'];
  else if (tr.status === 'failing') [state, label] = ['amber', 'failing'];
  else if (tr.degraded) [state, label] = ['amber', 'degraded'];
  else if (tr.lastClass === 'slow') [state, label] = ['amber', 'slow'];
  return { state, label, outageMs };
}

// availability is the share of requests that were answered, or null before any request.
export function availability(counters) {
  if (!counters.requests) return null;
  return (counters.requests - counters.failures) / counters.requests;
}
