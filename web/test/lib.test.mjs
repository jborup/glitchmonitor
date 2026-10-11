// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReorder } from '../static/lib/reorder.mjs';
import { createHistogram, addValue, quantile } from '../static/lib/histogram.mjs';
import { createSeries, addSample, addRecovered, allRecoveredAt, readSecond } from '../static/lib/series.mjs';
import {
  formatDuration, formatLatency, formatPercent, formatDateTime, summariseClasses, toCsv,
} from '../static/lib/format.mjs';
import {
  packSeries, unpackSeries, parseSpan, clampSpan, formatSpan, readExport, samplePath, MIN_SPAN_SEC, MAX_SPAN_SEC,
} from '../static/lib/savedrun.mjs';
import { createEpisodes, addBurst, settle, EPISODE_QUIET_MS } from '../static/lib/episodes.mjs';
import {
  restoreSession, trimLog, overlapsGap, logToCsv, logDetails, STORAGE_VERSION,
} from '../static/lib/session.mjs';

test('reorder delivers results in send order', () => {
  const got = [];
  const r = createReorder((x) => got.push(x));
  r.push(2, 'b');
  r.push(4, 'd');
  assert.deepEqual(got, []);
  assert.equal(r.pending, 2);
  r.push(1, 'a');
  assert.deepEqual(got, ['a', 'b']);
  r.push(3, 'c');
  assert.deepEqual(got, ['a', 'b', 'c', 'd']);
  assert.equal(r.pending, 0);
});

test('histogram quantiles are within 5 % of the exact value', () => {
  const h = createHistogram();
  assert.equal(quantile(h, 0.5), null);
  for (let ms = 1; ms <= 1000; ms++) addValue(h, ms);
  for (const [q, exact] of [[0.5, 500], [0.99, 990], [1, 1000]]) {
    const got = quantile(h, q);
    assert.ok(Math.abs(got - exact) / exact < 0.05, `q${q}: got ${got}, want about ${exact}`);
  }
});

test('histogram handles the extremes and survives a save and restore', () => {
  const h = createHistogram();
  for (const ms of [0, 0.2, 3, 3, 3, 10_000_000]) addValue(h, ms);
  assert.equal(quantile(h, 0.01), 0.5);
  assert.ok(quantile(h, 1) > 240_000);
  const restored = createHistogram(JSON.parse(JSON.stringify(h.counts)));
  assert.equal(restored.total, 6);
  assert.equal(quantile(restored, 0.5), quantile(h, 0.5));
  assert.equal(createHistogram([1, 2, 3]).total, 0, 'a histogram of another shape is not restored');
});

test('series keeps per-second maximum latency, failures and answering nodes', () => {
  const s = createSeries(10);
  assert.equal(readSecond(s, 100), null);
  addSample(s, 100, { latencyMs: 12, nodeIndex: 0 });
  addSample(s, 100, { latencyMs: 40, nodeIndex: 2 });
  addSample(s, 100, { latencyMs: 8, nodeIndex: 0 });
  addSample(s, 100, { latencyMs: null, nodeIndex: -1 });
  assert.deepEqual(readSecond(s, 100), { maxLatency: 40, answers: 3, failures: 1, recovered: 0, nodes: 0b101 });

  addSample(s, 101, { latencyMs: null, nodeIndex: -1 });
  assert.deepEqual(readSecond(s, 101), { maxLatency: null, answers: 0, failures: 1, recovered: 0, nodes: 0 });

  // A retry that succeeded is added later, to the second its request failed in.
  addSample(s, 101, { latencyMs: null, nodeIndex: -1 });
  assert.equal(allRecoveredAt(s, 101), false);
  addRecovered(s, 101);
  assert.equal(allRecoveredAt(s, 101), false, 'one of two failures recovered');
  addRecovered(s, 101);
  assert.equal(allRecoveredAt(s, 101), true);
  assert.equal(readSecond(s, 101).recovered, 2);
  assert.equal(allRecoveredAt(s, 100), false);
  assert.equal(allRecoveredAt(s, 55), false, 'a second without failures has nothing to recover');
  addRecovered(s, 77); // a second the ring no longer holds: ignored
});

test('series overwrites the oldest second once the ring is full', () => {
  const s = createSeries(10);
  addSample(s, 100, { latencyMs: 5, nodeIndex: 1 });
  addSample(s, 110, { latencyMs: 9, nodeIndex: 31 });
  assert.equal(readSecond(s, 100), null);
  assert.deepEqual(readSecond(s, 110), { maxLatency: 9, answers: 1, failures: 0, recovered: 0, nodes: 0x80000000 });
});

test('formatting', () => {
  assert.equal(formatDuration(null), '–');
  assert.equal(formatDuration(850.4), '850 ms');
  assert.equal(formatDuration(12_340), '12.3 s');
  assert.equal(formatDuration(125_000), '2 m 05 s');
  assert.equal(formatDuration(3_725_000), '1 h 02 m');
  assert.equal(formatLatency(3.14), '3.1');
  assert.equal(formatLatency(31.6), '32');
  assert.equal(formatPercent(null), '–');
  assert.equal(formatPercent(1), '100 %');
  assert.equal(formatPercent(0.999999), '99.999 %', 'never rounds up to 100');
  assert.equal(formatPercent(0.98765432), '98.765 %');
  assert.equal(summariseClasses({ http_5xx: 3, timeout: 20 }), 'timeout ×20, http_5xx ×3');
  assert.equal(formatDateTime(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03:04:05');
});

test('csv quotes only what needs it', () => {
  assert.equal(
    toCsv(['a', 'b'], [['plain', 'has,comma'], ['has "quote"', 'two\nlines'], [null, 5]]),
    'a,b\r\nplain,"has,comma"\r\n"has ""quote""","two\nlines"\r\n,5\r\n',
  );
});

test('log export as csv', () => {
  const csv = logToCsv([
    { id: 1, type: 'outage', target: 'route', start: Date.UTC(2026, 0, 2, 3, 4, 5), end: Date.UTC(2026, 0, 2, 3, 4, 6, 500), durationMs: 1500.4, text: 'timeout ×15' },
    { id: 2, type: 'marker', target: null, start: Date.UTC(2026, 0, 2, 3, 5, 0), text: 'node2 "power off", hard' },
  ]);
  assert.equal(csv, [
    'start,end,type,target,duration_ms,details',
    '2026-01-02T03:04:05.000Z,2026-01-02T03:04:06.500Z,outage,route,1500,timeout ×15',
    '2026-01-02T03:05:00.000Z,,marker,,,"node2 ""power off"", hard"',
    '',
  ].join('\r\n'));
});

test('log details say how the retries went', () => {
  assert.equal(logDetails({ text: '3 failed requests: timeout ×3' }), '3 failed requests: timeout ×3');
  assert.equal(logDetails({ text: '3 failed requests: timeout ×3', retries: 3, recovered: 2 }),
    '3 failed requests: timeout ×3; a retry succeeded for 2 of 3');
  assert.equal(logDetails({ text: '', retries: 1, recovered: 1 }), 'a retry succeeded for 1 of 1');
  const csv = logToCsv([{ id: 1, type: 'blip', target: 'route', start: 0, end: 1000, durationMs: 1000, text: 'x', retries: 2, recovered: 2 }]);
  assert.ok(csv.includes('x; a retry succeeded for 2 of 2'));
});

test('restoring a session closes what was running and logs the reload as a gap', () => {
  const saved = {
    v: STORAGE_VERSION,
    savedAt: 10_000,
    startedAt: 1000,
    nextLogId: 4,
    log: [
      { id: 1, type: 'outage', target: 'route', start: 2000, end: 2500, durationMs: 500, text: 'timeout ×5', open: false },
      { id: 2, type: 'outage', target: 'route', start: 9000, end: null, durationMs: null, text: '', open: true },
      { id: 3, type: 'degraded', target: 'gateway', start: 8000, end: null, durationMs: null, text: '2 of 3 pods', open: true },
    ],
    targets: {
      route: { counters: { requests: 90, failures: 15, outages: 2, downtimeMs: 500, longestOutageMs: 500 } },
      gateway: { counters: { requests: 90, failures: 0, outages: 0, downtimeMs: 0, longestOutageMs: 0 } },
    },
  };
  const s = restoreSession(saved, 25_000);
  assert.equal(s.startedAt, 1000);
  assert.deepEqual(s.log[1], {
    id: 2, type: 'outage', target: 'route', start: 9000, end: 10_000, durationMs: 1000,
    text: 'cut short by a page reload', open: false,
  });
  assert.equal(s.log[2].text, '2 of 3 pods; cut short by a page reload');
  assert.equal(s.log[2].durationMs, 2000);
  assert.deepEqual(s.targets.route.counters, { requests: 90, failures: 15, outages: 2, downtimeMs: 1500, longestOutageMs: 1000 });
  assert.deepEqual(s.targets.gateway.counters.downtimeMs, 0, 'a degraded period is not downtime');
  assert.deepEqual(s.log[3], {
    id: 4, type: 'gap', target: null, start: 10_000, end: 25_000, durationMs: 15_000, text: 'page reloaded', open: false,
  });
  assert.equal(s.nextLogId, 5);
});

test('a gap that was running at the reload becomes part of the reload gap', () => {
  const saved = {
    v: STORAGE_VERSION, savedAt: 10_000, startedAt: 1000, nextLogId: 3,
    log: [
      { id: 1, type: 'marker', target: null, start: 5000, text: 'x', open: false },
      { id: 2, type: 'gap', target: null, start: 8000, end: null, durationMs: null, text: 'tab in the background', open: true },
    ],
    targets: {},
  };
  const s = restoreSession(saved, 12_000);
  assert.deepEqual(s.log.map((e) => [e.type, e.start, e.end ?? null]), [['marker', 5000, null], ['gap', 8000, 12_000]]);
  assert.equal(s.log[1].text, 'page reloaded');
  assert.equal(s.log[1].durationMs, 4000);
});

test('unusable saved data is ignored', () => {
  assert.equal(restoreSession(null, 1), null);
  assert.equal(restoreSession({ v: 999, log: [] }, 1), null);
  assert.equal(restoreSession({ v: STORAGE_VERSION }, 1), null);
});

test('trimLog drops the oldest entries but keeps open ones', () => {
  const log = [
    { id: 1, open: true }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 },
  ];
  assert.deepEqual(trimLog(log, 3).map((e) => e.id), [1, 4, 5]);
  assert.equal(trimLog(log, 10), log);
});

test('overlapsGap', () => {
  const log = [
    { type: 'gap', start: 100, end: 200, open: false },
    { type: 'outage', start: 500, end: 600, open: false },
    { type: 'gap', start: 900, end: null, open: true },
  ];
  assert.equal(overlapsGap(log, 150, 300), true);
  assert.equal(overlapsGap(log, 201, 400), false);
  assert.equal(overlapsGap(log, 500, 600), false);
  assert.equal(overlapsGap(log, 950, 1000), true);
});

test('failures that keep coming back are one episode until it has been quiet', () => {
  const holder = createEpisodes();
  const burst = (startedAt, failures, cls = 'timeout') => ({ startedAt, t: startedAt + failures * 100, failures, classes: { [cls]: failures } });

  assert.deepEqual(addBurst(holder, burst(1000, 1)), { opened: true, closed: null });
  assert.deepEqual(addBurst(holder, burst(1500, 2)), { opened: false, closed: null });
  assert.deepEqual(addBurst(holder, burst(9000, 1, 'http_5xx')), { opened: false, closed: null });
  assert.deepEqual(holder.current, {
    start: 1000, end: 9100, failures: 4, bursts: 3, classes: { timeout: 3, http_5xx: 1 },
  });

  // Not quiet for long enough yet, then it is.
  assert.equal(settle(holder, 9100 + EPISODE_QUIET_MS), null);
  const ended = settle(holder, 9100 + EPISODE_QUIET_MS + 1);
  assert.equal(ended.end, 9100);
  assert.equal(ended.failures, 4);
  assert.equal(holder.current, null);
  assert.equal(settle(holder, 1e9), null);
});

test('a burst after the quiet time ends the old episode and starts a new one', () => {
  const holder = createEpisodes();
  addBurst(holder, { startedAt: 1000, t: 1100, failures: 1, classes: { timeout: 1 } });
  const { opened, closed } = addBurst(holder, { startedAt: 50_000, t: 50_200, failures: 2, classes: { timeout: 2 } });
  assert.equal(opened, true);
  assert.deepEqual(closed, { start: 1000, end: 1100, failures: 1, bursts: 1, classes: { timeout: 1 } });
  assert.deepEqual(holder.current, { start: 50_000, end: 50_200, failures: 2, bursts: 1, classes: { timeout: 2 } });
});

// ---- saved runs ----

test('a series survives being packed into an export and unpacked again', () => {
  const s = createSeries(100);
  addSample(s, 1000, { latencyMs: 12.34, nodeIndex: 0 });
  addSample(s, 1000, { latencyMs: 40.06, nodeIndex: 2 });
  addSample(s, 1001, { latencyMs: null, nodeIndex: -1 });
  addRecovered(s, 1001);
  addSample(s, 1004, { latencyMs: 7, nodeIndex: 31 });

  const packed = JSON.parse(JSON.stringify(packSeries(s)));
  assert.deepEqual(packed, {
    start: 1000,
    maxLatency: [40.1, null, null, null, 7],
    answers: [2, 0, 0, 0, 1],
    failures: [0, 1, 0, 0, 0],
    recovered: [0, 1, 0, 0, 0],
    nodes: [0b101, 0, 0, 0, 0x80000000],
  });

  const back = unpackSeries(packed);
  assert.deepEqual(readSecond(back, 1000), { maxLatency: Math.fround(40.1), answers: 2, failures: 0, recovered: 0, nodes: 0b101 });
  assert.deepEqual(readSecond(back, 1001), { maxLatency: null, answers: 0, failures: 1, recovered: 1, nodes: 0 });
  assert.equal(readSecond(back, 1002), null, 'a second without requests stays empty');
  assert.deepEqual(readSecond(back, 1004).nodes, 0x80000000);
  assert.equal(back.firstSec, 1000);
  assert.equal(back.lastSec, 1004);
  assert.equal(allRecoveredAt(back, 1001), true);
});

test('packing only covers what the ring still holds', () => {
  const s = createSeries(10);
  assert.equal(packSeries(s), null, 'nothing recorded, nothing to pack');
  for (let sec = 100; sec < 125; sec++) addSample(s, sec, { latencyMs: sec, nodeIndex: 0 });
  const packed = packSeries(s);
  assert.equal(packed.start, 115);
  assert.deepEqual(packed.maxLatency, [115, 116, 117, 118, 119, 120, 121, 122, 123, 124]);
});

test('time spans as people type them', () => {
  const cases = { '45s': 45, '10m': 600, '10 min': 600, '2h': 7200, '1h30m': 5400, '1h 30m 15s': 5415, '90': 90, '1.5h': 5400 };
  for (const [text, want] of Object.entries(cases)) assert.equal(parseSpan(text), want, text);
  for (const text of ['', 'soon', '5 days', 'h', '-5m']) assert.equal(parseSpan(text), null, text);
  assert.equal(clampSpan(5), MIN_SPAN_SEC);
  assert.equal(clampSpan(99999), MAX_SPAN_SEC);
  assert.equal(clampSpan(754.4), 754);
  assert.equal(formatSpan(45), '45 s');
  assert.equal(formatSpan(600), '10 min');
  assert.equal(formatSpan(5415), '1 h 30 min 15 s');
  assert.equal(formatSpan(21600), '6 h');
});

test('reading an export says what can be shown from it', () => {
  assert.match(readExport(null).error, /not a glitchmonitor export/);
  assert.match(readExport({ targets: [], log: [] }).error, /not a glitchmonitor export/);
  const base = { startedAt: '2026-01-02T03:00:00.000Z', exportedAt: '2026-01-02T03:30:00.000Z', log: [] };
  const old = readExport({ ...base, targets: [{ name: 'route' }] });
  assert.equal(old.hasSeries, false, 'an export from before the per-second data');
  assert.equal(old.end - old.start, 30 * 60 * 1000);
  const full = readExport({ ...base, targets: [{ name: 'route', series: { start: 1, maxLatency: [] } }] });
  assert.equal(full.hasSeries, true);
  assert.match(readExport({ ...base, startedAt: 'never', targets: [] }).error, /start and end time/);
});

test('a run named in the link must be a plain relative json path', () => {
  assert.equal(samplePath('demo/node-power-off.json'), 'demo/node-power-off.json');
  assert.equal(samplePath(' run-1.json '), 'run-1.json');
  for (const bad of ['', null, 'https://example.com/x.json', '//example.com/x.json', '/etc/x.json', '../x.json',
    'runs/../../x.json', 'runs//x.json', 'runs/x.txt', 'javascript:alert(1)//.json', 'runs/x.json?y=1']) {
    assert.equal(samplePath(bad), null, String(bad));
  }
});
