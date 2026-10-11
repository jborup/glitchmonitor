// SPDX-License-Identifier: AGPL-3.0-or-later

// Showing a saved run: the page opened with "?saved" takes a JSON export and
// shows how that run went, with its totals, timeline, "Who answered" strip and
// log. Nothing is probed and nothing is stored in this mode.

import { readExport, unpackSeries } from './lib/savedrun.mjs';
import { createSeries } from './lib/series.mjs';
import {
  formatDuration, formatLatency, formatPercent, formatClock, formatDateTime,
} from './lib/format.mjs';
import { createTimeline } from './timeline.js';
import { wireRange } from './rangecontrols.js';
import { renderLog } from './logview.js';

// The same order as the live dashboard gives its targets.
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'];

const $ = (sel, root = document) => root.querySelector(sel);
let wired = false;

export function showSavedRuns() {
  document.body.classList.add('saved-mode');
  document.title = 'glitchmonitor: saved run';
  $('#origin').textContent = location.origin;
  $('#status').hidden = true;
  $('#saved-open').hidden = false;

  const open = async (file) => {
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return fail(`${file.name} is not a JSON file.`);
    }
    const read = readExport(data);
    if (read.error) return fail(`${file.name}: ${read.error}`);
    show(read, file.name);
  };
  $('#saved-file').addEventListener('change', (event) => open(event.target.files[0]));
  // A file can also be dropped anywhere on the page.
  addEventListener('dragover', (event) => event.preventDefault());
  addEventListener('drop', (event) => {
    event.preventDefault();
    open(event.dataTransfer.files[0]);
  });
}

function fail(message) {
  const note = $('#saved-note');
  note.classList.add('error');
  note.textContent = message;
}

function show({ run, hasSeries, start, end }, fileName) {
  const note = $('#saved-note');
  note.classList.remove('error');
  note.textContent = `${fileName}: recorded from ${formatDateTime(start)} to ${formatDateTime(end)} `
    + `(${formatDuration(end - start)}), by a page loaded from ${run.pageOrigin ?? 'an unknown address'}`
    + `${run.config?.about?.version ? `, glitchmonitor ${run.config.about.version}` : ''}. This is a recording, not live.`;
  $('#since').textContent = `Saved run of ${formatDuration(end - start)}`;

  // Times in an export are ISO strings; the page works in epoch milliseconds.
  const log = run.log.map((e) => ({
    ...e,
    start: Date.parse(e.start),
    end: e.end == null ? null : Date.parse(e.end),
    open: false, // whatever was running ended with the recording
  }));

  const targets = run.targets.map((t, i) => ({
    name: t.name,
    color: SERIES_COLORS[Math.min(i, SERIES_COLORS.length - 1)],
    series: hasSeries ? unpackSeries(t.series) : createSeries(1),
  }));

  $('#tiles').replaceChildren(...run.targets.map(tile));
  $('#outside-note').textContent = '';
  $('#dashboard').hidden = false;
  $('#sec-timeline').hidden = !hasSeries;
  $('#saved-no-series').hidden = hasSeries;
  renderLog(log, end);

  if (hasSeries) {
    $('#chart').replaceChildren();
    let refresh = () => {};
    const timeline = createTimeline({
      chartEl: $('#chart'),
      stripEl: $('#strip'),
      readoutEl: $('#strip-readout'),
      source: { targets: () => targets, log: () => log, nodes: () => run.nodes ?? [], now: () => end },
      onViewChange: () => refresh(),
    });
    const whole = Math.ceil((end - start) / 1000);
    if (!wired) refresh = wireRange(timeline, { endName: 'the end of the run', endButton: 'End of run', wholeSpanSec: whole });
    wired = true;
    timeline.setSpan(whole);
    refresh();
  }
}

// tile shows one target's totals for the whole run.
function tile(t) {
  const el = $('#tile-template').content.firstElementChild.cloneNode(true);
  const set = (sel, text) => { $(sel, el).textContent = text; };
  el.dataset.state = t.outages ? 'red' : t.failures ? 'amber' : 'green';
  set('.name', t.name);
  set('.badge', t.outages ? `${t.outages} ${t.outages === 1 ? 'outage' : 'outages'}` : t.failures ? 'failed requests' : 'no failures');
  const link = $('.url', el);
  link.textContent = t.url;
  link.href = t.url;
  set('.latency .value', formatLatency(t.latencyP50Ms));
  set('.latency .unit', 'ms median');
  const nodes = [...new Set(Object.values(t.pods ?? {}))].sort();
  const podCount = Object.keys(t.pods ?? {}).length;
  set('.pod', `${podCount} ${podCount === 1 ? 'pod' : 'pods'} over the run`);
  set('.node', nodes.join(', ') || '–');
  set('.pods-label', 'Pods answering');
  set('.pods', '–');
  set('.requests', String(t.requests));
  set('.failures', String(t.failures));
  set('.retried', t.retriesSent ? `${t.retriesAnswered} of ${t.retriesSent}` : '–');
  set('.availability', formatPercent(t.availability));
  set('.quantiles', t.latencyP50Ms == null ? '–' : `${formatLatency(t.latencyP50Ms)} / ${formatLatency(t.latencyP99Ms)} ms`);
  set('.outages', String(t.outages));
  set('.longest', t.outages ? formatDuration(t.longestOutageMs) : '–');
  set('.downtime', t.outages ? formatDuration(t.totalDowntimeMs) : '–');
  set('.last-failure', t.lastFailure ? `${t.lastFailure.cls}, at ${formatClock(t.lastFailure.at)}` : 'none');
  return el;
}
