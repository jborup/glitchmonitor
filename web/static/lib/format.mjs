// SPDX-License-Identifier: AGPL-3.0-or-later

// Text formatting shared by the tiles, the log and the exports.

// formatDuration: "850 ms", "12.3 s", "2 m 05 s", "1 h 02 m".
export function formatDuration(ms) {
  if (ms == null) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h} h ${two(m)} m` : `${m} m ${two(s)} s`;
}

export function formatLatency(ms) {
  if (ms == null) return '–';
  return ms < 10 ? ms.toFixed(1) : ms.toFixed(0);
}

// formatPercent keeps enough decimals to tell 99.9 % from 99.99 %, and never
// rounds a value below 100 % up to "100".
export function formatPercent(ratio) {
  if (ratio == null) return '–';
  if (ratio === 1) return '100 %';
  const pct = Math.min(ratio * 100, 99.999);
  return `${(Math.floor(pct * 1000) / 1000).toFixed(3)} %`;
}

export function formatClock(epochMs) {
  const d = new Date(epochMs);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// formatDateTime: "2026-01-02 03:04:05" in local time, which sorts and cannot
// be misread the way day/month orders can.
export function formatDateTime(epochMs) {
  const d = new Date(epochMs);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${formatClock(epochMs)}`;
}

// summariseClasses: { timeout: 20, http_5xx: 3 } -> "timeout ×20, http_5xx ×3", most frequent first.
export function summariseClasses(classes) {
  return Object.entries(classes)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `${cls} ×${n}`)
    .join(', ');
}

function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
