// SPDX-License-Identifier: AGPL-3.0-or-later

// The log table, shared by the live dashboard and the view of a saved run.

import { formatDuration, formatClock } from './lib/format.mjs';
import { logDetails } from './lib/session.mjs';

export const LOG_ROWS_SHOWN = 300;

export const LOG_TYPES = {
  outage: 'Outage',
  degraded: 'Degraded',
  gap: 'Measurement gap',
  marker: 'Marker',
  pod: 'New pod',
  blip: 'Failed requests',
  'internal-outage': 'Inside: outage',
  'internal-failing': 'Inside: failing',
  'internal-degraded': 'Inside: degraded',
  'internal-requests': 'Inside: failed requests',
  endpoint: 'Endpoints',
};

const $ = (sel) => document.querySelector(sel);

// The log in time order. Entries are not added in that order: what the pods
// report from the inside arrives a few seconds after it happened.
export function sortLog(log) {
  return [...log].sort((a, b) => a.start - b.start || a.id - b.id);
}

// renderLog fills the table with the latest entries, newest first. t is the
// time against which a running entry's duration is shown.
export function renderLog(log, t) {
  const rows = sortLog(log).slice(-LOG_ROWS_SHOWN).reverse();
  $('#log tbody').replaceChildren(...rows.map((e) => {
    const tr = document.createElement('tr');
    tr.dataset.type = e.type;
    const duration = e.open ? `${formatDuration(t - e.start)}, running` : formatDuration(e.durationMs);
    // What lasted is shown with the time span it happened within.
    const span = !e.open && e.end != null && e.durationMs >= 1000;
    const cells = [
      span ? `${formatClock(e.start)} – ${formatClock(e.end)}` : formatClock(e.start),
      LOG_TYPES[e.type] ?? e.type,
      e.target ?? '',
      e.type === 'marker' || e.type === 'pod' || e.type === 'endpoint' ? '' : duration,
      logDetails(e),
    ];
    for (const text of cells) tr.append(Object.assign(document.createElement('td'), { textContent: text }));
    return tr;
  }));
  const running = log.filter((e) => e.open).length;
  $('#log-note').textContent = `${log.length} ${log.length === 1 ? 'entry' : 'entries'}${running ? `, ${running} running` : ''}`;
  $('#log-empty').hidden = log.length > 0;
  $('#log').hidden = log.length === 0;
  const hidden = log.length - rows.length;
  $('#log-more').hidden = hidden <= 0;
  if (hidden > 0) $('#log-more').textContent = `Showing the latest ${rows.length} of ${log.length} entries. The exports contain all of them.`;
}
