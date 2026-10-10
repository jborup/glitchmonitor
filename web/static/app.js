// SPDX-License-Identifier: AGPL-3.0-or-later

import { classify, isFailure } from './lib/classify.mjs';
import {
  createTracker, createCounters, record, view, availability, podsAnswering,
  DEGRADED_SAMPLES_PER_REPLICA,
} from './lib/tracker.mjs';
import { createReorder } from './lib/reorder.mjs';
import { createHistogram, addValue, quantile } from './lib/histogram.mjs';
import { createSeries, addSample, MAX_NODES } from './lib/series.mjs';
import {
  formatDuration, formatLatency, formatPercent, formatClock, summariseClasses,
} from './lib/format.mjs';
import {
  restoreSession, trimLog, overlapsGap, logToCsv, STORAGE_VERSION,
} from './lib/session.mjs';
import { createTimeline, WINDOWS, HISTORY_SEC } from './timeline.js';

const STORAGE_KEY = 'glitchmonitor.session';
const TILE_RENDER_MS = 100;
const SLOW_RENDER_MS = 1000;
const SAVE_MS = 5000;
const CONFIG_RETRY_MS = 1000;
const HEARTBEAT_MS = 250;
const STALL_MS = 2000;       // a heartbeat this late means the timers were not running
const LOG_ROWS_SHOWN = 300;
const MAX_SAVED_PODS = 200;

// Series colours in fixed order, checked for colour-blind separation on the
// panel background. They identify a target; green, amber and red mean state.
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'];

const LOG_TYPES = {
  outage: 'Outage',
  degraded: 'Degraded',
  gap: 'Measurement gap',
  marker: 'Marker',
  pod: 'New pod',
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
};

let timeline = null;

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

  const target = {
    name: def.name,
    url: def.url,
    color: SERIES_COLORS[Math.min(index, SERIES_COLORS.length - 1)],
    el,
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
  target.latest = null;       // newest answer by send order, shown straight away
  target.outageEntry = null;
  target.degradedEntry = null;
  target.reorder = createReorder((result) => onResult(target, result));
}

async function probe(target) {
  const { browser } = state.cfg;
  const epoch = state.epoch;
  const seq = ++target.sent;
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
  if (epoch !== state.epoch) return;

  const cls = classify(outcome, browser.slowMs);
  const answered = !isFailure(cls);
  const result = {
    t, cls,
    latencyMs: answered ? outcome.latencyMs : null,
    pod: answered ? body.pod : null,
    node: answered ? body.node : null,
  };
  if (!target.latest || seq > target.latest.seq) target.latest = { seq, ...result };
  target.reorder.push(seq, result);
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
  if (isFailure(r.cls)) target.lastFailure = { cls: r.cls, at: r.t };
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
    exportedAt: new Date(t).toISOString(),
    startedAt: new Date(state.startedAt).toISOString(),
    pageOrigin: location.origin,
    userAgent: navigator.userAgent,
    config: state.cfg,
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
        pods: Object.fromEntries(target.pods),
      };
    }),
    log: state.log.map((e) => ({
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
  setText($('.outages', el), String(counters.outages));
  setText($('.longest', el), counters.outages ? formatDuration(Math.max(counters.longestOutageMs, running)) : '–');
  setText($('.downtime', el), counters.outages ? formatDuration(counters.downtimeMs + running) : '–');
  setText($('.availability', el), formatPercent(availability(counters)));
  const p50 = quantile(target.hist, 0.5);
  const p99 = quantile(target.hist, 0.99);
  setText($('.quantiles', el), p50 == null ? '–' : `${formatLatency(p50)} / ${formatLatency(p99)} ms`);
  setText($('.last-failure', el), lastFailure ? `${lastFailure.cls}, ${formatAgo(t - lastFailure.at)}` : 'none');
}

function renderLog(t) {
  const body = $('#log tbody');
  const rows = state.log.slice(-LOG_ROWS_SHOWN).reverse();
  body.replaceChildren(...rows.map((e) => {
    const tr = document.createElement('tr');
    tr.dataset.type = e.type;
    const duration = e.open ? `${formatDuration(t - e.start)}, running` : formatDuration(e.durationMs);
    const cells = [
      formatClock(e.start),
      LOG_TYPES[e.type] ?? e.type,
      e.target ?? '',
      e.type === 'marker' || e.type === 'pod' ? '' : duration,
      e.text,
    ];
    for (const text of cells) tr.append(Object.assign(document.createElement('td'), { textContent: text }));
    return tr;
  }));
  $('#log-empty').hidden = state.log.length > 0;
  $('#log').hidden = state.log.length === 0;
  const hidden = state.log.length - rows.length;
  $('#log-more').hidden = hidden <= 0;
  if (hidden > 0) $('#log-more').textContent = `Showing the latest ${rows.length} of ${state.log.length} entries. The exports contain all of them.`;
}

// renderSlow: once a second, and at once after something the user did.
function renderSlow() {
  const t = now();
  $('#since').textContent = `Measuring since ${formatClock(state.startedAt)} (${formatDuration(t - state.startedAt)})`;
  timeline.update();
  if (state.logDirty || state.log.some((e) => e.open)) {
    renderLog(t);
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
  $('#banner-dismiss').addEventListener('click', () => { $('#banner').hidden = true; });
  $('#reset').addEventListener('click', reset);
  $('#export-json').addEventListener('click', exportJson);
  $('#export-csv').addEventListener('click', () => download('csv', 'text/csv', logToCsv(state.log)));
  $('#marker-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#marker-text');
    addLog({ type: 'marker', start: now(), text: input.value.trim() || 'marker' });
    input.value = '';
    renderSlow();
  });

  const windows = $('#windows');
  WINDOWS.forEach((w, i) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: w.label });
    button.setAttribute('aria-pressed', String(i === 0));
    button.addEventListener('click', () => {
      for (const other of windows.children) other.setAttribute('aria-pressed', String(other === button));
      timeline.setWindow(w.sec);
    });
    windows.append(button);
  });
}

async function main() {
  $('#origin').textContent = location.origin;
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
  setInterval(save, SAVE_MS);
  addEventListener('pagehide', save);
  renderSlow();
}

main();
