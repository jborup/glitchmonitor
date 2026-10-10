// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-second history of one target for the timeline: a ring buffer, so memory
// is bounded however long the page stays open.

export const MAX_NODES = 32; // one bit per node in a 32-bit mask

export function createSeries(capacitySec) {
  return {
    capacity: capacitySec,
    sec: new Float64Array(capacitySec),       // which second a slot holds; 0 = empty
    maxLatency: new Float32Array(capacitySec), // NaN when nothing answered
    answers: new Uint32Array(capacitySec),
    failures: new Uint32Array(capacitySec),
    recovered: new Uint32Array(capacitySec),   // of the failures, how many were fine on a retry
    nodes: new Uint32Array(capacitySec),       // bit i set: node i answered
  };
}

// addSample records one probe result in the second it was sent. latencyMs is
// null for a failure; nodeIndex is -1 when the answering node is unknown.
export function addSample(s, sec, { latencyMs, nodeIndex }) {
  const i = sec % s.capacity;
  if (s.sec[i] !== sec) {
    s.sec[i] = sec;
    s.maxLatency[i] = NaN;
    s.answers[i] = 0;
    s.failures[i] = 0;
    s.recovered[i] = 0;
    s.nodes[i] = 0;
  }
  if (latencyMs == null) {
    s.failures[i]++;
    return;
  }
  s.answers[i]++;
  if (!(s.maxLatency[i] >= latencyMs)) s.maxLatency[i] = latencyMs;
  if (nodeIndex >= 0 && nodeIndex < MAX_NODES) s.nodes[i] |= 1 << nodeIndex;
}

// addRecovered notes that a request that failed in second sec succeeded when
// retried. The retry ends later than the request, so it is added separately.
export function addRecovered(s, sec) {
  const i = sec % s.capacity;
  if (s.sec[i] === sec) s.recovered[i]++;
}

// readSecond returns what is known about one second, or null when there is nothing.
export function readSecond(s, sec) {
  const i = sec % s.capacity;
  if (sec <= 0 || s.sec[i] !== sec) return null;
  return {
    maxLatency: Number.isNaN(s.maxLatency[i]) ? null : s.maxLatency[i],
    answers: s.answers[i],
    failures: s.failures[i],
    recovered: s.recovered[i],
    nodes: s.nodes[i] >>> 0,
  };
}

// Allocation-free readers for drawing: the timeline reads every second of its window each time.
export function maxLatencyAt(s, sec) {
  const i = sec % s.capacity;
  return s.sec[i] === sec && !Number.isNaN(s.maxLatency[i]) ? s.maxLatency[i] : null;
}

export function failuresAt(s, sec) {
  const i = sec % s.capacity;
  return s.sec[i] === sec ? s.failures[i] : 0;
}

// allRecoveredAt: every request that failed in that second was fine on a retry.
export function allRecoveredAt(s, sec) {
  const i = sec % s.capacity;
  return s.sec[i] === sec && s.failures[i] > 0 && s.recovered[i] >= s.failures[i];
}

export function nodesAt(s, sec) {
  const i = sec % s.capacity;
  return s.sec[i] === sec ? s.nodes[i] >>> 0 : 0;
}
