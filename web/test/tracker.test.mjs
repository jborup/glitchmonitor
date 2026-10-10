// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTracker, createCounters, record, view, availability, podsInWindow,
} from '../static/lib/tracker.mjs';

const OPTS = { failThreshold: 1, expectedReplicas: 3, podWindowMs: 5000 };
const PODS = ['pod-a', 'pod-b', 'pod-c'];

// feed sends one result every 100 ms starting at `from` and returns all events.
// Each item is a class name, or [class, pod]; answers rotate over PODS by default.
function feed(tr, from, items) {
  const events = [];
  items.forEach((item, i) => {
    const [cls, pod] = Array.isArray(item) ? item : [item, PODS[i % PODS.length]];
    events.push(...record(tr, { t: from + i * 100, cls, pod }));
  });
  return events;
}
const times = (n, item) => Array.from({ length: n }, () => item);
const types = (events) => events.map((e) => e.type);

test('a healthy target stays green and counts requests', () => {
  const tr = createTracker(OPTS);
  assert.equal(view(tr, 0).state, 'idle');
  assert.deepEqual(feed(tr, 1000, times(60, 'ok')), []);
  assert.deepEqual(view(tr, 7000), { state: 'green', label: 'ok', outageMs: null });
  assert.deepEqual(tr.counters, { requests: 60, failures: 0, outages: 0, downtimeMs: 0, longestOutageMs: 0 });
  assert.equal(availability(tr.counters), 1);
});

test('an outage starts at the first failure and ends at the first success', () => {
  const tr = createTracker(OPTS);
  feed(tr, 0, times(30, 'ok'));
  const start = feed(tr, 3000, ['timeout']);
  assert.deepEqual(start, [{ type: 'outage_start', t: 3000, detectedAt: 3000 }]);
  assert.deepEqual(view(tr, 3450), { state: 'red', label: 'outage', outageMs: 450 });

  assert.deepEqual(feed(tr, 3100, ['timeout', 'http_5xx', 'http_5xx']), []);
  const end = feed(tr, 3400, [['ok', 'pod-a']]);
  assert.deepEqual(end, [{
    type: 'outage_end', t: 3400, startedAt: 3000, durationMs: 400,
    failures: 4, classes: { timeout: 2, http_5xx: 2 },
  }]);
  assert.equal(view(tr, 3500).state, 'green');
  assert.deepEqual(tr.counters, { requests: 35, failures: 4, outages: 1, downtimeMs: 400, longestOutageMs: 400 });
  assert.equal(availability(tr.counters), 31 / 35);
});

test('longest outage and total downtime accumulate over outages', () => {
  const tr = createTracker(OPTS);
  feed(tr, 0, ['ok', 'network_error', 'ok', 'timeout', 'timeout', 'timeout', 'ok']);
  assert.equal(tr.counters.outages, 2);
  assert.equal(tr.counters.downtimeMs, 100 + 300);
  assert.equal(tr.counters.longestOutageMs, 300);
});

test('failThreshold delays the outage but dates it from the first failure', () => {
  const tr = createTracker({ ...OPTS, failThreshold: 3 });
  feed(tr, 0, times(5, 'ok'));

  assert.deepEqual(feed(tr, 500, ['timeout', 'timeout']), []);
  assert.deepEqual(view(tr, 700), { state: 'amber', label: 'failing', outageMs: null });
  assert.deepEqual(feed(tr, 700, ['ok']), [], 'two failures then a success is not an outage');
  assert.equal(tr.counters.outages, 0);
  assert.equal(tr.counters.failures, 2);

  const events = feed(tr, 800, ['timeout', 'timeout', 'timeout', 'timeout', 'ok']);
  assert.deepEqual(events, [
    { type: 'outage_start', t: 800, detectedAt: 1000 },
    { type: 'outage_end', t: 1200, startedAt: 800, durationMs: 400, failures: 4, classes: { timeout: 4 } },
  ]);
});

test('slow answers are amber but not failures', () => {
  const tr = createTracker(OPTS);
  feed(tr, 0, ['ok', 'slow']);
  assert.deepEqual(view(tr, 200), { state: 'amber', label: 'slow', outageMs: null });
  assert.equal(tr.counters.failures, 0);
  feed(tr, 200, ['ok']);
  assert.equal(view(tr, 300).state, 'green');
});

test('degraded: fewer pods answer than expected', async (t) => {
  await t.test('not judged before the window holds enough answers', () => {
    const tr = createTracker(OPTS);
    assert.deepEqual(feed(tr, 0, times(23, ['ok', 'pod-a'])), []);
    assert.equal(view(tr, 2300).state, 'green');
    assert.deepEqual(types(feed(tr, 2300, [['ok', 'pod-a']])), ['degraded_start']);
  });

  await t.test('starts when a pod drops out of the window and ends when it is back', () => {
    const tr = createTracker(OPTS);
    assert.deepEqual(feed(tr, 0, times(60, 'ok')), []);
    // pod-c stops answering at t=6000; its last answer (t=5900) leaves the 5 s window at t=10900.
    const twoPods = Array.from({ length: 60 }, (_, i) => ['ok', PODS[i % 2]]);
    const events = feed(tr, 6000, twoPods);
    assert.deepEqual(events, [{ type: 'degraded_start', t: 10900, pods: ['pod-a', 'pod-b'] }]);
    assert.deepEqual(view(tr, 12000), { state: 'amber', label: 'degraded', outageMs: null });
    assert.equal(tr.counters.failures, 0, 'degraded is not failure');

    const back = feed(tr, 12000, [['ok', 'pod-d']]);
    assert.deepEqual(back, [{ type: 'degraded_end', t: 12000, startedAt: 10900, durationMs: 1100 }]);
    assert.equal(view(tr, 12100).state, 'green');
  });

  await t.test('an outage ends the degraded period and takes over', () => {
    const tr = createTracker(OPTS);
    feed(tr, 0, times(30, ['ok', 'pod-a']));
    assert.equal(view(tr, 3000).label, 'degraded');
    const events = feed(tr, 3000, ['timeout']);
    assert.deepEqual(types(events), ['degraded_end', 'outage_start']);
    assert.equal(events[0].t, 3000);
    assert.equal(view(tr, 3100).label, 'outage');
  });

  await t.test('after an outage the pods are judged afresh', () => {
    const tr = createTracker(OPTS);
    feed(tr, 0, times(30, 'ok'));
    feed(tr, 3000, ['timeout']);
    // Two pods come back. The pre-outage answer of pod-c must not count.
    const twoPods = Array.from({ length: 30 }, (_, i) => ['ok', PODS[i % 2]]);
    const events = feed(tr, 3100, twoPods);
    assert.deepEqual(types(events), ['outage_end', 'degraded_start']);
    assert.equal(events[1].t, 3100 + 23 * 100);
  });

  await t.test('one expected replica is never degraded', () => {
    const tr = createTracker({ ...OPTS, expectedReplicas: 1 });
    assert.deepEqual(feed(tr, 0, times(100, ['ok', 'pod-a'])), []);
  });
});

test('podsInWindow forgets what left the window', () => {
  const tr = createTracker(OPTS);
  feed(tr, 0, [['ok', 'pod-a'], ['ok', 'pod-b']]);
  assert.deepEqual(podsInWindow(tr, 4900), ['pod-a', 'pod-b']);
  assert.deepEqual(podsInWindow(tr, 5050), ['pod-b']);
  assert.deepEqual(podsInWindow(tr, 6000), []);
});

test('counters can be restored into a new tracker', () => {
  const counters = { ...createCounters(), requests: 10, failures: 2, outages: 1, downtimeMs: 200, longestOutageMs: 200 };
  const tr = createTracker(OPTS, counters);
  feed(tr, 0, ['ok', 'timeout', 'ok']);
  assert.deepEqual(counters, { requests: 13, failures: 3, outages: 2, downtimeMs: 300, longestOutageMs: 200 });
});

test('availability is null before any request', () => {
  assert.equal(availability(createCounters()), null);
});
