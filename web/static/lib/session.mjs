// SPDX-License-Identifier: AGPL-3.0-or-later

// The session is what survives an accidental reload: the log and the counters.
// Pure logic; app.js does the localStorage and DOM parts.

import { toCsv } from './format.mjs';

// Bumped when saved data would no longer mean the same; older sessions are then dropped.
export const STORAGE_VERSION = 3;
export const MAX_LOG_ENTRIES = 5000;

// A log entry is { id, type, target, start, end, durationMs, text, open }.
//   type: 'outage' | 'degraded' | 'gap' | 'marker' | 'pod' | 'note' and the inside ones;
//         a note is text for the log only and is not drawn on the timeline
//   start/end: epoch ms; point events have no end
//   open: true while an outage, degraded period or gap is still running
//   retries, recovered: for failed requests from outside, how many were sent
//     once more and how many of those were then answered

// restoreSession turns saved data back into a session at time now. Whatever
// was still running when the page went away is closed at the time of the last
// save, an outage's time is added to its target's counters, and the reload
// itself is logged as a measurement gap, which absorbs a gap that was already
// running. Returns null when nothing usable was saved.
export function restoreSession(saved, now) {
  if (!saved || saved.v !== STORAGE_VERSION || !Array.isArray(saved.log)) return null;
  const session = {
    startedAt: saved.startedAt,
    nextLogId: saved.nextLogId,
    log: saved.log.filter((entry) => !(entry.open && entry.type === 'gap')),
    targets: saved.targets || {},
  };
  const gapStart = Math.min(saved.savedAt, ...saved.log.filter((e) => e.open && e.type === 'gap').map((e) => e.start));
  for (const entry of session.log) {
    if (!entry.open) continue;
    entry.open = false;
    entry.end = saved.savedAt;
    entry.durationMs = Math.max(0, saved.savedAt - entry.start);
    entry.text = [entry.text, 'cut short by a page reload'].filter(Boolean).join('; ');
    const counters = session.targets[entry.target]?.counters;
    if (entry.type === 'outage' && counters) {
      counters.downtimeMs += entry.durationMs;
      counters.longestOutageMs = Math.max(counters.longestOutageMs, entry.durationMs);
    }
  }
  session.log.push({
    id: session.nextLogId++,
    type: 'gap',
    target: null,
    start: gapStart,
    end: now,
    durationMs: Math.max(0, now - gapStart),
    text: 'page reloaded',
    open: false,
  });
  return session;
}

// trimLog drops the oldest entries beyond the cap, but never one that is still open.
export function trimLog(log, max = MAX_LOG_ENTRIES) {
  let excess = log.length - max;
  if (excess <= 0) return log;
  return log.filter((entry) => entry.open || excess-- <= 0);
}

// overlapsGap reports whether [start, end] touches a measurement gap.
export function overlapsGap(log, start, end) {
  return log.some((e) => e.type === 'gap' && e.start <= end && (e.open || e.end >= start));
}

// logDetails is the text of an entry with how its retries went.
export function logDetails(entry) {
  const parts = [];
  if (entry.text) parts.push(entry.text);
  if (entry.retries) parts.push(`a retry succeeded for ${entry.recovered ?? 0} of ${entry.retries}`);
  return parts.join('; ');
}

const iso = (ms) => (ms == null ? '' : new Date(ms).toISOString());

export function logToCsv(log) {
  const header = ['start', 'end', 'type', 'target', 'duration_ms', 'details'];
  const rows = log.map((e) => [
    iso(e.start),
    iso(e.end),
    e.type,
    e.target ?? '',
    e.durationMs == null ? '' : Math.round(e.durationMs),
    logDetails(e),
  ]);
  return toCsv(header, rows);
}
