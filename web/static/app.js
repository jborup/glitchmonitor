// SPDX-License-Identifier: AGPL-3.0-or-later

import { classify, isFailure, failureLabel } from './lib/classify.mjs';
import {
  createTracker, createCounters, record, view, availability, podsAnswering,
  DEGRADED_SAMPLES_PER_REPLICA,
} from './lib/tracker.mjs';
import { createReorder } from './lib/reorder.mjs';
import { createEpisodes, addBurst, settle } from './lib/episodes.mjs';
import { createHistogram, addValue, quantile } from './lib/histogram.mjs';
import {
  createSeries, addSample, addRecovered, MAX_NODES,
} from './lib/series.mjs';
import {
  formatDuration, formatLatency, formatPercent, formatClock, summariseClasses,
} from './lib/format.mjs';
import {
  restoreSession, trimLog, overlapsGap, logToCsv, STORAGE_VERSION,
} from './lib/session.mjs';
import {
  createInternalStore, ingest, buildMatrix, assess, cellView, STALE_MS,
} from './lib/internal.mjs';
import { packSeries, EXPORT_FORMAT } from './lib/savedrun.mjs';
import { createTimeline, HISTORY_SEC } from './timeline.js';
import { wireRange } from './rangecontrols.js';
import { renderLog, sortLog } from './logview.js';

const STORAGE_KEY = 'glitchmonitor.session';
const PREFS_KEY = 'glitchmonitor.prefs';
const TILE_RENDER_MS = 100;
const SLOW_RENDER_MS = 1000;
const SAVE_MS = 5000;
const CONFIG_RETRY_MS = 1000;
const HEARTBEAT_MS = 250;
const STALL_MS = 2000;       // a heartbeat this late means the timers were not running
const MAX_SAVED_PODS = 200;
const INTERNAL_POLL_MS = 1000;
const RETRY_ATTRIBUTION_MS = 1000;
const VERDICT_SETTLE_MS = 5000; // after the first report, wait for the other pods before judging
const VERDICT_HOLD_MS = 2000;   // a new verdict must hold this long before it is logged
const SPARK_SECONDS = 60;
const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 22;
// How old what is shown may get before the page says so, for a pod's report
// and for a cell's latest result alike. A report normally arrives every one to
// three seconds per pod and now and then takes five, so a lower limit is noise.
const OLD_MS = 8000;

// Series colours in fixed order, checked for colour-blind separation on the
// panel background. They identify a target; green, amber and red mean state.
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'];

// How the states the pods report map onto tile colours.
const INTERNAL_STATES = {
  idle: 'idle', ok: 'green', slow: 'amber', degraded: 'amber', failing: 'amber', outage: 'red',
};

const $ = (sel, root = document) => root.querySelector(sel);

// Epoch milliseconds on the monotonic clock: comparable to Date.now(), but it
// never jumps when the system clock is adjusted.
const now = () => performance.timeOrigin + performance.now();

const state = {
  cfg: null,
  epoch: 0,        // bumped by reset, so answers to earlier probes are dropped
  startedAt: 0,
  targets: [],
  nodes: [],       // every node seen, in order of appearance; the index is its bit in a series
  log: [],
  nextLogId: 1,
  logDirty: true,
  gap: null,       // the open "tab in the background" log entry
  sound: { on: false, ctx: null },
  internal: newInternalState(),
  // What the viewer chose; kept across reloads and across a reset.
  prefs: { flash: true, sparks: true, open: {} },
};

function newInternalState() {
  return {
    store: createInternalStore(),
    entries: new Map(), // incident key -> its log entry
    available: true,    // false once a target says it runs no internal probes
    firstReportAt: Infinity,
    status: null,       // the verdict for the inside that is currently shown and logged
    pending: null,      // the verdict the latest reports give, and since when
    pendingSince: 0,
    entry: null,        // the open log entry of a degraded or outage verdict
  };
}

function loadPrefs() {
  try {
    Object.assign(state.prefs, JSON.parse(localStorage.getItem(PREFS_KEY)));
  } catch {
    // Nothing saved, or storage is blocked: keep the defaults.
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    // Storage is blocked: the choice lasts until the page is closed.
  }
}

let timeline = null;
let refreshRange = () => {};

// ---------- log ----------

function addLog(entry) {
  const e = {
    id: state.nextLogId++, target: null, end: null, durationMs: null, text: '', open: false, ...entry,
  };
  state.log.push(e);
  state.log = trimLog(state.log);
  state.logDirty = true;
  return e;
}

function closeLog(entry, end, text) {
  entry.open = false;
  entry.end = end;
  entry.durationMs = Math.max(0, end - entry.start);
  if (text != null) entry.text = text;
  state.logDirty = true;
}

// ---------- targets ----------

function createTarget(def, index, saved) {
  const el = $('#tile-template').content.firstElementChild.cloneNode(true);
  $('.name', el).textContent = def.name;
  if (def.url === location.origin) {
    const here = document.createElement('span');
    here.className = 'here';
    here.textContent = ' (this page)';
    $('.name', el).append(here);
  }
  const link = $('.url', el);
  link.textContent = def.url;
  link.href = def.url;
  $('.pods-label', el).textContent = `Pods answering (last ${state.cfg.browser.podWindowSec} s)`;
  $('#tiles').append(el);

  // A chip per target in the section's heading, so the state shows when it is folded.
  const note = document.createElement('span');
  note.className = 'chip';
  $('#outside-note').append(`${def.name} `, note, ' ');

  const target = {
    name: def.name,
    url: def.url,
    color: SERIES_COLORS[Math.min(index, SERIES_COLORS.length - 1)],
    el,
    note,
  };
  initTarget(target, saved);
  return target;
}

// initTarget (re)sets everything a target measures; saved restores its counters.
function initTarget(target, saved) {
  const { browser } = state.cfg;
  target.sent = 0;
  target.counters = { ...createCounters(), ...saved?.counters };
  target.tracker = createTracker({
    failThreshold: browser.failThreshold,
    expectedReplicas: browser.expectedReplicas,
    podWindowMs: browser.podWindowSec * 1000,
  }, target.counters);
  target.hist = createHistogram(saved?.hist);
  target.series = createSeries(HISTORY_SEC + 60);
  target.pods = new Map(saved?.pods ?? []);
  target.lastFailure = saved?.lastFailure ?? null;
  target.retries = { sent: 0, recovered: 0, ...saved?.retries }; // failed requests sent once more
  target.latest = null;       // newest answer by send order, shown straight away
  target.outageEntry = null;
  target.degradedEntry = null;
  target.episodes = createEpisodes(); // failed requests short of an outage, grouped
  target.episodeEntry = null;
  target.reorder = createReorder((result) => onResult(target, result));
}

// request sends one /api/ping and says what came of it.
async function request(target) {
  const { browser } = state.cfg;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), browser.timeoutMs);
  const t = now();
  const started = performance.now();
  let outcome;
  let body = null;
  try {
    const res = await fetch(`${target.url}/api/ping`, {
      cache: 'no-store',
      mode: 'cors',
      credentials: 'omit',
      signal: ctl.signal,
    });
    try {
      body = await res.json();
    } catch (err) {
      if (ctl.signal.aborted) throw err;
    }
    outcome = {
      status: res.status,
      latencyMs: performance.now() - started,
      badBody: typeof body?.pod !== 'string',
    };
  } catch {
    outcome = ctl.signal.aborted ? { timedOut: true } : { networkError: true };
  } finally {
    clearTimeout(timer);
  }
  const cls = classify(outcome, browser.slowMs);
  return { t, cls, outcome, body };
}

async function probe(target) {
  const epoch = state.epoch;
  const seq = ++target.sent;
  const { t, cls, outcome, body } = await request(target);
  if (epoch !== state.epoch) return;

  const answered = !isFailure(cls);
  const result = {
    t, cls,
    label: failureLabel(cls, outcome.status),
    latencyMs: answered ? outcome.latencyMs : null,
    pod: answered ? body.pod : null,
    node: answered ? body.node : null,
  };
  if (!target.latest || seq > target.latest.seq) target.latest = { seq, ...result };
  target.reorder.push(seq, result);

  // What would a web application get if it simply tried again? The failed
  // request has already been counted; the retry is only noted beside it. The
  // browser sends it on the connection it already has to the route or gateway,
  // as an application's own retry would go.
  if (!answered && state.cfg.browser.retry) {
    const again = await request(target);
    if (epoch !== state.epoch) return;
    noteRetry(target, t, !isFailure(again.cls));
  }
}

// noteRetry records how the retry of the request sent at time t went: on the
// tile, in the timeline's "failed" lane, and on the log entry that request
// belongs to.
function noteRetry(target, t, recovered) {
  target.retries.sent++;
  if (recovered) {
    target.retries.recovered++;
    addRecovered(target.series, Math.floor(t / 1000));
  }
  // The log entry is looked up a moment later: the first failures of an outage
  // are retried before the outage has been declared and given its entry.
  const epoch = state.epoch;
  setTimeout(() => {
    if (epoch !== state.epoch) return;
    const covers = (e) => e && e.target === target.name && (e.type === 'outage' || e.type === 'blip')
      && e.start <= t && (e.open || e.end >= t);
    let entry = [target.outageEntry, target.episodeEntry].find(covers);
    for (let i = state.log.length - 1; !entry && i >= 0 && i >= state.log.length - 50; i--) {
      if (covers(state.log[i])) entry = state.log[i];
    }
    if (!entry) return;
    entry.retries = (entry.retries ?? 0) + 1;
    entry.recovered = (entry.recovered ?? 0) + (recovered ? 1 : 0);
    state.logDirty = true;
  }, RETRY_ATTRIBUTION_MS);
}

// onResult gets every result exactly once, in the order the probes were sent.
function onResult(target, r) {
  let nodeIndex = -1;
  if (r.node) {
    nodeIndex = state.nodes.indexOf(r.node);
    if (nodeIndex < 0 && state.nodes.length < MAX_NODES) nodeIndex = state.nodes.push(r.node) - 1;
  }
  addSample(target.series, Math.floor(r.t / 1000), { latencyMs: r.latencyMs, nodeIndex });
  if (r.latencyMs != null) addValue(target.hist, r.latencyMs);
  if (isFailure(r.cls)) target.lastFailure = { cls: r.label, at: r.t };
  if (r.pod && !target.pods.has(r.pod)) {
    target.pods.set(r.pod, r.node);
    addLog({
      type: 'pod', target: target.name, start: r.t,
      text: `${r.pod} on ${r.node || 'an unknown node'} answered for the first time`,
    });
  }
  for (const event of record(target.tracker, r)) onEvent(target, event);
}

function onEvent(target, e) {
  const { expectedReplicas } = state.cfg.browser;
  switch (e.type) {
    case 'outage_start':
      target.outageEntry = addLog({ type: 'outage', target: target.name, start: e.t, open: true });
      flash();
      beep();
      break;
    case 'blip': {
      // One log line from the first failed request until it has been quiet for
      // a while, however often it flickers in between.
      const { opened, closed } = addBurst(target.episodes, e);
      if (closed) endEpisode(target, closed);
      if (opened) target.episodeEntry = addLog({ type: 'blip', target: target.name, start: e.startedAt, open: true });
      target.episodeEntry.text = episodeText(target.episodes.current);
      state.logDirty = true;
      break;
    }
    case 'outage_end': {
      let text = `${e.failures} failed ${e.failures === 1 ? 'request' : 'requests'}: ${summariseClasses(e.classes)}`;
      if (overlapsGap(state.log, e.startedAt, e.t)) text += '; overlaps a measurement gap';
      if (target.outageEntry) closeLog(target.outageEntry, e.t, text);
      target.outageEntry = null;
      break;
    }
    case 'degraded_start':
      target.degradedEntry = addLog({
        type: 'degraded', target: target.name, start: e.t, open: true,
        text: `${e.pods.length} of ${expectedReplicas} pods answering: ${e.pods.join(', ')}`,
      });
      break;
    case 'degraded_end':
      if (target.degradedEntry) closeLog(target.degradedEntry, e.t);
      target.degradedEntry = null;
      break;
  }
}

function episodeText(ep) {
  const failed = `${ep.failures} failed ${ep.failures === 1 ? 'request' : 'requests'}`;
  const bursts = ep.bursts > 1 ? ` in ${ep.bursts} bursts` : '';
  return `${failed}${bursts}: ${summariseClasses(ep.classes)}`;
}

function endEpisode(target, ep) {
  if (target.episodeEntry) closeLog(target.episodeEntry, ep.end, episodeText(ep));
  target.episodeEntry = null;
}

// Fires on a fixed schedule, not "interval after the previous answer", so a hanging
// request does not slow the probe rate down. Ticks missed while the tab was throttled
// are skipped, not replayed in a burst.
function startProbing(target) {
  const { intervalMs } = state.cfg.browser;
  let next = performance.now();
  const tick = () => {
    probe(target);
    next += intervalMs;
    const t = performance.now();
    if (next <= t) next = t + intervalMs;
    setTimeout(tick, next - t);
  };
  tick();
}

// ---------- internal probes ----------

// Every pod reports what it sees from inside the cluster. A request through an
// external target lands on one pod, so polling every target every second
// collects all of them within a few seconds.
async function pollInternal(target) {
  if (target.tracker.status !== 'up') return;
  const epoch = state.epoch;
  let report;
  try {
    // The mini-graph data is fetched even when the graphs are switched off:
    // the cell labels and the verdict are worked out from it.
    const res = await fetch(`${target.url}/api/internal?spark=${SPARK_SECONDS}`, {
      cache: 'no-store',
      mode: 'cors',
      credentials: 'omit',
      signal: AbortSignal.timeout(state.cfg.browser.timeoutMs),
    });
    if (res.status === 404) state.internal.available = false;
    if (!res.ok) return;
    report = await res.json();
  } catch {
    return; // the external tiles already show that the target is in trouble
  }
  if (epoch !== state.epoch || !Array.isArray(report?.targets)) return;
  onInternalReport(report);
}

function onInternalReport(report) {
  const { store, entries } = state.internal;
  const t = now();
  state.internal.firstReportAt = Math.min(state.internal.firstReportAt, t);
  const { incidents, changes } = ingest(store, report, t);

  for (const incident of incidents) {
    // Only what happened while this page was measuring belongs in its log.
    if (incident.start < state.startedAt) continue;
    // What one pod sees of the Service or the API server is logged as failed
    // requests: one entry per episode, which the pod keeps open while the
    // failures keep coming. Whether the inside is degraded or down is judged
    // over all pods (trackVerdict), and a pod that cannot be reached shows up there.
    if (incident.kind === 'pod' || incident.type !== 'failing') continue;
    const open = incident.end == null;
    const parts = [];
    parts.push(`${incident.failures} of ${incident.requests} requests failed: ${summariseClasses(incident.classes ?? {})}`);
    if (incident.longestRun > 1) parts.push(`at most ${incident.longestRun} in a row`);
    if (incident.retry) parts.push(`a retry on a new connection succeeded for ${incident.recovered ?? 0} of them`);
    // Whether the request had gone out is what decides if repeating it is safe.
    parts.push(incident.sent ? `${incident.sent} failed after the request had been sent` : 'none had been sent yet');
    if (incident.note) parts.push(incident.note);
    const text = parts.join('; ');
    let entry = entries.get(incident.key);
    if (!entry) {
      entry = addLog({
        type: 'internal-requests',
        key: incident.key,
        target: `${incident.label}${incident.self ? ' (itself)' : ''}, from ${incident.reporterNode}`,
        start: incident.start,
      });
      entries.set(incident.key, entry);
    }
    // The pod is the authority on its own incidents: take over what it says now.
    if (entry.open !== open || entry.end !== incident.end || entry.text !== text) {
      Object.assign(entry, { open, end: incident.end, durationMs: incident.durationMs, text });
      state.logDirty = true;
    }
  }

  for (const change of changes) {
    if (change.t < state.startedAt) continue;
    const who = change.pod ? `${change.pod} (${change.ip})` : change.ip;
    addLog({
      type: 'endpoint', start: change.t,
      text: change.ready ? `${who} is now a ready endpoint of the Service` : `${who} is no longer a ready endpoint of the Service`,
    });
  }
}

// An incident stays "running" only while its pod keeps reporting it.
function closeOrphanedIncidents(t) {
  const { store, entries } = state.internal;
  for (const [key, entry] of entries) {
    if (!entry.open) continue;
    const reporter = store.reporters.get(key.split('|')[0]);
    if (reporter && t - reporter.receivedAt <= STALE_MS) continue;
    closeLog(entry, reporter?.receivedAt ?? t, 'the reporting pod stopped reporting; the real end is not known');
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

// The verdict for the inside is logged when it changes, once it has held for
// a moment: reports arrive pod by pod, so a single one must not flip it.
function trackVerdict(assessment, t) {
  const iv = state.internal;
  const collecting = t - iv.firstReportAt < VERDICT_SETTLE_MS;
  const status = collecting && assessment.status !== 'unknown' ? 'collecting' : assessment.status;
  if (status !== iv.pending) {
    iv.pending = status;
    iv.pendingSince = t;
  }
  if (status !== iv.status && (iv.status == null || t - iv.pendingSince >= VERDICT_HOLD_MS)) {
    if (iv.entry?.open) closeLog(iv.entry, iv.pendingSince);
    iv.entry = null;
    iv.status = status;
    if (status === 'degraded' || status === 'failing' || status === 'outage') {
      iv.entry = addLog({ type: `internal-${status}`, target: 'inside the cluster', start: iv.pendingSince, open: true, seen: {} });
      if (status === 'outage') {
        flash();
        beep();
      }
    }
  }
  // The log keeps the set of reasons that held the longest. While a pod goes
  // away or comes back the reasons pass through in-between wordings for a
  // second or two; those must not pile up in the entry.
  if (iv.entry?.open && status === iv.status) {
    const { seen } = iv.entry;
    const now_ = assessment.reasons.join('; ');
    seen[now_] = (seen[now_] ?? 0) + 1;
    const text = Object.keys(seen).reduce((best, key) => (seen[key] > seen[best] ? key : best));
    if (text !== iv.entry.text) {
      iv.entry.text = text;
      state.logDirty = true;
    }
  }
  return iv.status;
}

const VERDICT_TEXT = {
  ok: 'ok',
  degraded: 'degraded',
  failing: 'failing',
  outage: 'outage',
  unknown: 'unknown',
  collecting: 'collecting',
};
const VERDICT_STATE = {
  ok: 'green', degraded: 'amber', failing: 'orange', outage: 'red', down: 'red', unknown: 'idle', collecting: 'idle',
};

function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// sparkline draws the last minute of one cell.
//   line         the slowest answer in each second; scaleMs is shared by the
//                cells of a row, so they can be compared
//   bar          requests failed in that second; its height is the share that failed
//     red        ... and failed again when retried on a new connection (or no retry was made)
//     yellow     ... but succeeded when retried
//   bottom edge  amber while fewer pods answered than expected (degraded)
function sparkline(spark, scaleMs, degraded, retried) {
  const n = spark.latencyMs.length;
  const [w, h] = [SPARK_WIDTH, SPARK_HEIGHT];
  const step = w / n;
  const x = (i) => (i + 0.5) * step;
  const y = (ms) => h - 2 - (Math.min(ms, scaleMs) / scaleMs) * (h - 4);
  const root = svg('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img' });
  let max = 0;
  let path = '';
  let drawing = false;
  for (let i = 0; i < n; i++) {
    const failed = spark.failures[i];
    if (failed) {
      const height = Math.max(3, (failed / spark.requests[i]) * h);
      const lost = retried ? failed - spark.recovered[i] : failed;
      const bar = { x: (i * step).toFixed(1), width: Math.max(1.5, step).toFixed(1) };
      root.append(svg('rect', { class: 'retried', ...bar, y: h - height, height }));
      if (lost) root.append(svg('rect', { class: 'fail', ...bar, y: h - height * (lost / failed), height: height * (lost / failed) }));
    }
    const sec = (spark.start + i) * 1000;
    if (degraded.some(([from, to]) => sec + 1000 > from && sec < to)) {
      root.append(svg('rect', { class: 'deg', x: (i * step).toFixed(1), y: h - 2, width: (step + 0.5).toFixed(1), height: 2 }));
    }
    const ms = spark.latencyMs[i];
    if (ms < 0) {
      drawing = false;
      continue;
    }
    max = Math.max(max, ms);
    path += `${drawing ? 'L' : 'M'}${x(i).toFixed(1)} ${y(ms).toFixed(1)}`;
    drawing = true;
  }
  if (path) root.append(svg('path', { class: 'line', d: path }));
  const title = svg('title');
  title.textContent = `Last ${n} s: slowest answer ${formatLatency(max)} ms`;
  root.append(title);
  return root;
}

function renderInternal(t) {
  const { store, available } = state.internal;
  const section = $('#sec-inside');
  section.hidden = !available || store.reporters.size === 0;
  if (section.hidden) return;
  const matrix = buildMatrix(store, t);
  const { columns, rows } = matrix;
  const assessment = assess(matrix, state.cfg.browser.expectedReplicas);
  const status = trackVerdict(assessment, t);

  // The verdict, also shown in the section's heading so it is visible when folded.
  for (const chip of [$('#inside-chip'), $('#inside-status')]) {
    chip.dataset.state = VERDICT_STATE[status];
    setText(chip, VERDICT_TEXT[status]);
  }
  let explanation = assessment.reasons.join('; ');
  if (status === 'ok') explanation = `All ${columns.length} pods report, reach each other and get answers from the Service.`;
  if (status === 'collecting') explanation = 'Collecting the first reports from the pods.';
  setText($('#inside-reasons'), explanation);

  $('#inside-nodes').replaceChildren(...assessment.nodes.map((n) => {
    const chip = el('span', { className: 'chip', textContent: n.status });
    chip.dataset.state = VERDICT_STATE[n.status];
    return el('li', {}, chip, el('strong', { textContent: ` ${n.node}: ` }), n.text);
  }));

  const head = el('tr', {}, el('th', { textContent: 'What is probed' }));
  for (const c of columns) {
    const age = c.stale ? `no report for ${formatDuration(c.ageMs)}` : `report ${formatDuration(c.ageMs)} old`;
    head.append(el('th', { className: c.stale ? 'stale' : c.ageMs > OLD_MS ? 'old' : '' },
      el('span', { className: 'from', textContent: `seen from ${c.node || 'unknown node'}` }),
      el('span', { className: 'detail', textContent: c.pod }),
      el('span', { className: 'detail age', textContent: age })));
  }
  $('#matrix thead').replaceChildren(head);

  const showSparks = state.prefs.sparks;
  $('#matrix tbody').replaceChildren(...rows.map((row) => {
    const title = el('th', {}, el('span', { className: 'from', textContent: row.label }));
    let destination = row.kind === 'service' ? 'Service' : 'API server';
    if (row.kind === 'pod') {
      destination = row.node || row.podIP;
      title.append(el('span', { className: 'detail', textContent: `on ${row.node || 'an unknown node'} · ${row.podIP}` }));
      const endpoint = row.inEndpoints == null ? 'endpoint state unknown'
        : row.inEndpoints ? 'ready endpoint of the Service' : 'not a ready endpoint of the Service';
      title.append(el('span', { className: 'detail', textContent: endpoint }));
      if (row.verdict === 'dead-in-endpoints') {
        title.append(el('span', { className: 'verdict red', textContent: '⚠ Down, but the Service still sends it requests' }));
      } else if (row.verdict === 'alive-not-in-endpoints') {
        title.append(el('span', { className: 'verdict amber', textContent: 'Alive, but taken out of the Service' }));
      }
    } else if (row.kind === 'apiserver') {
      title.append(el('span', { className: 'detail', textContent: 'spread over the API server on every control-plane node' }));
    }

    const scaleMs = Math.max(5, ...row.cells.flatMap((cell) => cell?.spark?.latencyMs ?? []));

    const tr = el('tr', {}, title);
    row.cells.forEach((cell, i) => {
      const column = columns[i];
      if (!cell) {
        tr.append(el('td', { className: 'none', textContent: '–' }));
        return;
      }
      const td = el('td', { className: column.stale ? 'stale' : '' });
      const shown = cellView(cell, row.kind);
      td.dataset.state = shown.state;
      const answered = cell.last && (cell.last.class === 'ok' || cell.last.class === 'slow');
      let value = answered ? `${formatLatency(cell.last.latencyMs)} ms` : '';
      if (cell.state === 'outage' && cell.outageSince != null) {
        // The pod's clock dates it; add the time since its report arrived.
        value = `for ${formatDuration(column.serverTime - cell.outageSince + column.ageMs)}`;
      }
      td.append(
        el('span', { className: 'chip', textContent: shown.label }),
        el('span', { className: 'value', textContent: ` ${value}` }),
      );

      // What failed, for the same minute the mini graph shows.
      const notes = [];
      if (cell.self) notes.push('itself');
      const { counters, minute } = cell;
      if (minute?.failures) {
        let note = `${minute.failures} of ${minute.requests} failed in the last minute`;
        if (column.retry) note += `, ${minute.recovered} of them fine on a retry`;
        notes.push(note);
      } else if (!minute && counters.failures) {
        notes.push(`${counters.failures} of ${counters.requests} requests failed`);
      }
      if (cell.last && !answered) notes.push(`latest: ${failureLabel(cell.last.class, cell.last.status)}`);
      if (notes.length) td.append(el('span', { className: 'detail', textContent: notes.join(' · ') }));
      // How old the value shown is: the age of the pod's latest result when it
      // reported, plus the time since that report arrived. Said out loud once
      // it is old enough that the cell may no longer describe the present.
      const resultAge = cell.last ? column.serverTime - cell.last.t + column.ageMs : null;
      if (resultAge != null && resultAge > OLD_MS && !column.stale) {
        td.append(el('span', { className: 'detail old', textContent: `latest result is ${formatDuration(resultAge)} old` }));
      }
      td.title = `${resultAge == null ? 'No result yet' : `Latest result: ${formatDuration(resultAge)} old`}. `
        + `Since this pod started: ${counters.failures} of ${counters.requests} requests failed`
        + `${column.retry ? `, ${counters.recovered ?? 0} of them fine on a retry` : ''}.`;

      if (showSparks && cell.spark) {
        const degraded = cell.incidents.filter((in_) => in_.type === 'degraded').map((in_) => [in_.start, in_.end ?? column.serverTime + 1000]);
        td.append(sparkline(cell.spark, scaleMs, degraded, column.retry),
          el('span', { className: 'detail pair', textContent: `${column.node} → ${cell.self ? 'itself' : destination}` }));
      }
      tr.append(td);
    });
    return tr;
  }));
}

// ---------- measurement gaps ----------

function showBanner(text) {
  $('#banner-text').textContent = text;
  $('#banner').hidden = false;
}

function watchForGaps() {
  const onVisibility = () => {
    if (document.hidden) {
      if (!state.gap) state.gap = addLog({ type: 'gap', start: now(), open: true, text: 'tab in the background' });
      save();
    } else if (state.gap) {
      closeLog(state.gap, now());
      showBanner(`This tab was in the background for ${formatDuration(state.gap.durationMs)}. `
        + 'Browsers slow down timers in background tabs, so that time is logged as a measurement gap. '
        + 'Keep this tab visible during a test.');
      state.gap = null;
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  // Timers can also stop while the tab is visible: the laptop sleeps, or the
  // browser is starved. A late heartbeat shows it.
  let last = performance.now();
  setInterval(() => {
    const t = performance.now();
    const late = t - last - HEARTBEAT_MS;
    last = t;
    if (late > STALL_MS && !state.gap) {
      const end = now();
      addLog({ type: 'gap', start: end - late, end, durationMs: late, text: 'timers were not running (sleep or an overloaded browser)' });
      showBanner(`Timers in this tab stopped for ${formatDuration(late)}; that time is logged as a measurement gap.`);
    }
  }, HEARTBEAT_MS);
}

// ---------- flash and beep ----------

function flash() {
  if (!state.prefs.flash) return;
  const el = $('#flash');
  el.classList.remove('on');
  void el.offsetWidth; // restart the animation
  el.classList.add('on');
}

function beep() {
  const { on, ctx } = state.sound;
  if (!on || !ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.32);
}

// Browsers only allow sound after a user gesture, so it starts off and this click enables it.
function toggleSound() {
  const sound = state.sound;
  sound.on = !sound.on;
  if (sound.on) {
    sound.ctx ??= new AudioContext();
    sound.ctx.resume();
    beep();
  }
  const button = $('#sound');
  button.setAttribute('aria-pressed', String(sound.on));
  button.textContent = sound.on ? '🔊 Sound on' : '🔇 Enable sound';
}

function toggleFlash() {
  state.prefs.flash = !state.prefs.flash;
  savePrefs();
  showPrefs();
  flash();
}

function toggleSparks() {
  state.prefs.sparks = !state.prefs.sparks;
  savePrefs();
  showPrefs();
  renderInternal(now());
}

function showPrefs() {
  const { flash: flashOn, sparks } = state.prefs;
  $('#flash-toggle').setAttribute('aria-pressed', String(flashOn));
  $('#flash-toggle').textContent = flashOn ? '⚡ Flash on' : '⚡ Enable flash';
  $('#sparks-toggle').setAttribute('aria-pressed', String(sparks));
  $('#sparks-toggle').textContent = sparks ? 'Mini graphs on' : 'Show mini graphs';
}

// Every section folds like "How to read this", and stays the way it was left.
function wireSections() {
  for (const section of document.querySelectorAll('details[data-section]')) {
    const open = state.prefs.open[section.dataset.section];
    if (open != null) section.open = open;
    section.addEventListener('toggle', () => {
      state.prefs.open[section.dataset.section] = section.open;
      savePrefs();
      if (section.open && timeline) renderSlow();
    });
  }
}

// ---------- save, restore, reset, export ----------

function save() {
  const data = {
    v: STORAGE_VERSION,
    savedAt: now(),
    startedAt: state.startedAt,
    nextLogId: state.nextLogId,
    log: state.log,
    targets: Object.fromEntries(state.targets.map((t) => [t.name, {
      url: t.url,
      counters: t.counters,
      hist: t.hist.counts,
      pods: [...t.pods].slice(-MAX_SAVED_PODS),
      lastFailure: t.lastFailure,
      retries: t.retries,
    }])),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage is full or blocked: keep measuring in memory.
  }
}

function loadSaved() {
  try {
    return restoreSession(JSON.parse(localStorage.getItem(STORAGE_KEY)), now());
  } catch {
    return null;
  }
}

function reset() {
  if (!confirm('Reset all counters, the timeline and the log?')) return;
  state.epoch++;
  state.startedAt = now();
  state.nodes = [];
  state.log = [];
  state.nextLogId = 1;
  state.logDirty = true;
  state.gap = null;
  state.internal = newInternalState();
  for (const target of state.targets) initTarget(target);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was stored.
  }
  $('#banner').hidden = true;
  renderSlow();
}

function download(name, type, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  a.download = `glitchmonitor-${stamp}.${name}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportJson() {
  const t = now();
  const data = {
    format: EXPORT_FORMAT,
    exportedAt: new Date(t).toISOString(),
    startedAt: new Date(state.startedAt).toISOString(),
    pageOrigin: location.origin,
    userAgent: navigator.userAgent,
    config: state.cfg,
    // Node names by the bit they have in each series' "nodes" value.
    nodes: state.nodes,
    targets: state.targets.map((target) => {
      const running = view(target.tracker, t).outageMs ?? 0;
      return {
        name: target.name,
        url: target.url,
        requests: target.counters.requests,
        failures: target.counters.failures,
        outages: target.counters.outages,
        longestOutageMs: Math.max(target.counters.longestOutageMs, running),
        totalDowntimeMs: target.counters.downtimeMs + running,
        availability: availability(target.counters),
        latencyP50Ms: quantile(target.hist, 0.5),
        latencyP99Ms: quantile(target.hist, 0.99),
        retriesSent: target.retries.sent,
        retriesAnswered: target.retries.recovered,
        pods: Object.fromEntries(target.pods),
        lastFailure: target.lastFailure,
        // Per second: slowest answer, answers, failures, retries that helped, and
        // which nodes answered. This is what lets a saved run be shown again.
        series: packSeries(target.series),
      };
    }),
    log: sortLog(state.log).map((e) => ({
      ...e,
      start: new Date(e.start).toISOString(),
      end: e.end == null ? null : new Date(e.end).toISOString(),
    })),
  };
  download('json', 'application/json', JSON.stringify(data, null, 2));
}

// ---------- rendering ----------

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function formatAgo(ms) {
  return ms < 1000 ? 'just now' : `${formatDuration(ms)} ago`;
}

function renderTile(target, t) {
  const { el, counters, latest, lastFailure } = target;
  const v = view(target.tracker, t);
  const running = v.outageMs ?? 0;
  el.dataset.state = v.state;
  setText($('.badge', el), v.label);
  if (v.outageMs != null) {
    setText($('.latency .value', el), formatDuration(v.outageMs));
    setText($('.latency .unit', el), 'outage');
  } else {
    setText($('.latency .value', el), formatLatency(latest?.latencyMs));
    setText($('.latency .unit', el), 'ms');
  }
  setText($('.pod', el), latest?.pod || '–');
  setText($('.node', el), latest?.node || '–');
  setText($('.pods', el), `${podsAnswering(target.tracker, t)} of ${state.cfg.browser.expectedReplicas}`);
  setText($('.requests', el), String(counters.requests));
  setText($('.failures', el), String(counters.failures));
  setText($('.retried', el), target.retries.sent ? `${target.retries.recovered} of ${target.retries.sent}` : '–');
  setText($('.outages', el), String(counters.outages));
  setText($('.longest', el), counters.outages ? formatDuration(Math.max(counters.longestOutageMs, running)) : '–');
  setText($('.downtime', el), counters.outages ? formatDuration(counters.downtimeMs + running) : '–');
  setText($('.availability', el), formatPercent(availability(counters)));
  const p50 = quantile(target.hist, 0.5);
  const p99 = quantile(target.hist, 0.99);
  setText($('.quantiles', el), p50 == null ? '–' : `${formatLatency(p50)} / ${formatLatency(p99)} ms`);
  setText(target.note, v.label);
  target.note.dataset.state = v.state;
  setText($('.last-failure', el), lastFailure ? `${lastFailure.cls}, ${formatAgo(t - lastFailure.at)}` : 'none');
}

// renderSlow: once a second, and at once after something the user did.
function renderSlow() {
  const t = now();
  $('#since').textContent = `Measuring since ${formatClock(state.startedAt)} (${formatDuration(t - state.startedAt)})`;
  timeline.update();
  for (const target of state.targets) {
    const ended = settle(target.episodes, t);
    if (ended) endEpisode(target, ended);
  }
  closeOrphanedIncidents(t);
  renderInternal(t);
  refreshRange();
  if (state.logDirty || state.log.some((e) => e.open)) {
    renderLog(state.log, t);
    state.logDirty = false;
  }
}

// ---------- start ----------

async function loadConfig() {
  const status = $('#status');
  for (;;) {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cfg = await res.json();
      status.hidden = true;
      return cfg;
    } catch (err) {
      status.classList.add('error');
      status.textContent = `Could not load /api/config (${err.message}); retrying…`;
      await new Promise((resolve) => setTimeout(resolve, CONFIG_RETRY_MS));
    }
  }
}

function describeThresholds() {
  const b = state.cfg.browser;
  const perWindow = Math.floor((b.podWindowSec * 1000) / b.intervalMs);
  const needed = b.expectedReplicas * DEGRADED_SAMPLES_PER_REPLICA;
  $('#thresholds').textContent = `One request every ${b.intervalMs} ms per target, timeout ${b.timeoutMs} ms, `
    + `slow above ${b.slowMs} ms. An outage starts after ${b.failThreshold} consecutive `
    + `${b.failThreshold === 1 ? 'failure' : 'failures'}. ${b.expectedReplicas} pods are expected to answer within ${b.podWindowSec} s.`;
  $('#degraded-off').hidden = b.expectedReplicas < 2 || perWindow >= needed;
  $('#degraded-off').textContent = `Degraded detection is off: it needs at least ${needed} answers per ${b.podWindowSec} s window `
    + `to tell a missing pod from chance, and this configuration sends ${perWindow}.`;
}

function wireControls() {
  $('#sound').addEventListener('click', toggleSound);
  $('#flash-toggle').addEventListener('click', toggleFlash);
  $('#sparks-toggle').addEventListener('click', toggleSparks);
  showPrefs();
  wireSections();
  $('#banner-dismiss').addEventListener('click', () => { $('#banner').hidden = true; });
  $('#reset').addEventListener('click', reset);
  $('#export-json').addEventListener('click', exportJson);
  $('#export-csv').addEventListener('click', () => download('csv', 'text/csv', logToCsv(sortLog(state.log))));
  $('#marker-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#marker-text');
    addLog({ type: 'marker', start: now(), text: input.value.trim() || 'marker' });
    input.value = '';
    renderSlow();
  });

  refreshRange = wireRange(timeline, { endName: 'now', endButton: 'Live' });
}

async function main() {
  // A saved run is shown by its own code, which never probes anything.
  if (new URLSearchParams(location.search).has('saved')) {
    (await import('./saved.js')).showSavedRuns();
    return;
  }
  $('#origin').textContent = location.origin;
  loadPrefs();
  state.cfg = await loadConfig();
  const cfg = state.cfg;

  $('#version').textContent = `glitchmonitor ${cfg.about.version}`;
  if (cfg.about.sourceURL) {
    $('#source').href = cfg.about.sourceURL;
    $('#source-offer').hidden = false;
  }

  let external = cfg.external.filter((t) => t.enabled);
  if (external.length === 0) {
    // No external targets configured, e.g. running locally: probe wherever the page came from.
    external = [{ name: 'self', url: location.origin }];
  }

  const saved = loadSaved();
  state.startedAt = saved?.startedAt ?? now();
  state.log = saved?.log ?? [];
  state.nextLogId = saved?.nextLogId ?? 1;
  for (const entry of state.log) {
    if (entry.key) state.internal.entries.set(entry.key, entry);
  }
  state.targets = external.map((def, i) => {
    const s = saved?.targets[def.name];
    return createTarget(def, i, s?.url === def.url ? s : null);
  });

  // The chart measures its container, so the dashboard must be visible first.
  $('#dashboard').hidden = false;
  timeline = createTimeline({
    chartEl: $('#chart'),
    stripEl: $('#strip'),
    readoutEl: $('#strip-readout'),
    source: { targets: () => state.targets, log: () => state.log, nodes: () => state.nodes, now },
    onViewChange: () => refreshRange(),
  });
  describeThresholds();
  wireControls();
  watchForGaps();

  for (const target of state.targets) startProbing(target);
  setInterval(() => {
    const t = now();
    for (const target of state.targets) renderTile(target, t);
  }, TILE_RENDER_MS);
  setInterval(renderSlow, SLOW_RENDER_MS);
  setInterval(() => {
    if (state.internal.available) state.targets.forEach(pollInternal);
  }, INTERNAL_POLL_MS);
  setInterval(save, SAVE_MS);
  addEventListener('pagehide', save);
  renderSlow();
}

main();
