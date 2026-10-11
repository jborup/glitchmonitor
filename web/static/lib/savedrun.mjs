// SPDX-License-Identifier: AGPL-3.0-or-later

// Saved runs: what an export has to carry so that a run can be opened again
// later and shown with its timeline, and the time spans the timeline accepts.
// Pure logic.

import { createSeries } from './series.mjs';

// The version of the export format. 2 added the per-second data behind the
// timeline and the "Who answered" strip; an export without it can still be
// opened, but only its log and totals can be shown.
export const EXPORT_FORMAT = 2;

export const MIN_SPAN_SEC = 30;
export const MAX_SPAN_SEC = 6 * 3600;

// packSeries turns a target's per-second history into plain arrays for the
// export: one entry per second from the first second still held to the last.
// maxLatency is null where nothing answered, and rounded to 0.1 ms.
export function packSeries(s) {
  if (!s.lastSec) return null;
  const start = Math.max(s.firstSec, s.lastSec - s.capacity + 1);
  const n = s.lastSec - start + 1;
  const out = {
    start,
    maxLatency: new Array(n), answers: new Array(n), failures: new Array(n),
    recovered: new Array(n), nodes: new Array(n),
  };
  for (let k = 0; k < n; k++) {
    const sec = start + k;
    const i = sec % s.capacity;
    const held = s.sec[i] === sec;
    out.maxLatency[k] = held && !Number.isNaN(s.maxLatency[i]) ? Math.round(s.maxLatency[i] * 10) / 10 : null;
    out.answers[k] = held ? s.answers[i] : 0;
    out.failures[k] = held ? s.failures[i] : 0;
    out.recovered[k] = held ? s.recovered[i] : 0;
    out.nodes[k] = held ? s.nodes[i] >>> 0 : 0;
  }
  return out;
}

// unpackSeries is the reverse: a series the timeline can draw from.
export function unpackSeries(packed) {
  const n = packed.maxLatency.length;
  const s = createSeries(Math.max(n, 1) + 60);
  for (let k = 0; k < n; k++) {
    if (!packed.answers[k] && !packed.failures[k]) continue;
    const sec = packed.start + k;
    const i = sec % s.capacity;
    s.sec[i] = sec;
    s.maxLatency[i] = packed.maxLatency[k] == null ? NaN : packed.maxLatency[k];
    s.answers[i] = packed.answers[k];
    s.failures[i] = packed.failures[k];
    s.recovered[i] = packed.recovered[k];
    s.nodes[i] = packed.nodes[k];
    if (!s.firstSec) s.firstSec = sec;
    s.lastSec = sec;
  }
  return s;
}

// parseSpan reads a time span as people type it: "45s", "10m", "2h", "1h30m",
// "90" (seconds). Returns seconds, or null when it cannot be read.
export function parseSpan(text) {
  const t = String(text).trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?:in)?)?(?:(\d+(?:\.\d+)?)s)?$/.exec(t);
  if (!m || !t) return null;
  return Math.round((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0));
}

// clampSpan keeps a span inside what the timeline can show.
export function clampSpan(sec) {
  return Math.min(MAX_SPAN_SEC, Math.max(MIN_SPAN_SEC, Math.round(sec)));
}

// formatSpan: 45 -> "45 s", 600 -> "10 min", 5400 -> "1 h 30 min".
export function formatSpan(sec) {
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : '', s ? `${s} s` : ''].filter(Boolean).join(' ');
}

// samplePath checks the value of "?saved=<path>", which names a run to open
// straight away. Only a plain relative path to a .json file on the same site is
// accepted, so a link cannot make the page fetch from somewhere else.
export function samplePath(value) {
  const path = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/.test(path)) return null;
  if (path.includes('..') || path.includes('//')) return null;
  return path;
}

// readExport checks that an object is a glitchmonitor export and says what it
// can show. Returns { error } or { run, hasSeries, start, end } with times in
// epoch milliseconds.
export function readExport(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.targets) || !Array.isArray(data.log) || !data.exportedAt) {
    return { error: 'This file is not a glitchmonitor export.' };
  }
  const start = Date.parse(data.startedAt);
  const end = Date.parse(data.exportedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return { error: 'The export has no readable start and end time.' };
  const hasSeries = data.targets.length > 0 && data.targets.every((t) => t.series && Array.isArray(t.series.maxLatency));
  return { run: data, hasSeries, start, end };
}
