// SPDX-License-Identifier: AGPL-3.0-or-later

import { classify, isFailure, tileState } from './lib/classify.mjs';

const RENDER_INTERVAL_MS = 200;
const CONFIG_RETRY_MS = 1000;

const $ = (sel, root = document) => root.querySelector(sel);

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

function createTarget({ name, url }) {
  const el = $('#tile-template').content.firstElementChild.cloneNode(true);
  $('.name', el).textContent = name;
  if (url === location.origin) {
    const here = document.createElement('span');
    here.className = 'here';
    here.textContent = ' (this page)';
    $('.name', el).append(here);
  }
  const link = $('.url', el);
  link.textContent = url;
  link.href = url;
  $('#tiles').append(el);
  return {
    name, url, el,
    sent: 0,
    requests: 0,
    failures: 0,
    latest: null,      // newest result by send order: { seq, cls, latencyMs, pod, node }
    lastFailure: null, // { cls, at }
  };
}

async function probe(target, browser) {
  const seq = ++target.sent;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), browser.timeoutMs);
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
  target.requests++;
  if (isFailure(cls)) {
    target.failures++;
    target.lastFailure = { cls, at: Date.now() };
  }
  // Probes overlap while a target is timing out, so answers can arrive out of order.
  if (!target.latest || seq > target.latest.seq) {
    const answered = !isFailure(cls);
    target.latest = {
      seq, cls,
      latencyMs: answered ? outcome.latencyMs : null,
      pod: answered ? body.pod : null,
      node: answered ? body.node : null,
    };
  }
}

// Fires on a fixed schedule, not "interval after the previous answer", so a hanging
// request does not slow the probe rate down. Ticks missed while the tab was throttled
// are skipped, not replayed in a burst.
function startProbing(target, browser) {
  let next = performance.now();
  const tick = () => {
    probe(target, browser);
    next += browser.intervalMs;
    const now = performance.now();
    if (next <= now) next = now + browser.intervalMs;
    setTimeout(tick, next - now);
  };
  tick();
}

function formatAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function render(target) {
  const { el, latest, lastFailure } = target;
  el.dataset.state = tileState(latest?.cls);
  setText($('.badge', el), latest ? latest.cls : 'waiting');
  setText($('.latency .value', el), latest?.latencyMs == null ? '–' : latest.latencyMs.toFixed(0));
  setText($('.pod', el), latest?.pod || '–');
  setText($('.node', el), latest?.node || '–');
  setText($('.requests', el), String(target.requests));
  setText($('.failures', el), String(target.failures));
  setText($('.last-failure', el),
    lastFailure ? `${lastFailure.cls}, ${formatAgo(Date.now() - lastFailure.at)}` : 'none');
}

async function main() {
  $('#origin').textContent = location.origin;
  const cfg = await loadConfig();

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
  const targets = external.map(createTarget);
  for (const target of targets) startProbing(target, cfg.browser);
  setInterval(() => targets.forEach(render), RENDER_INTERVAL_MS);
}

main();
