// SPDX-License-Identifier: AGPL-3.0-or-later

// Latency histogram with geometric buckets: constant memory however long the
// page stays open, quantiles accurate to about 5 %, and small enough to save.

const MIN_MS = 0.5;
const RATIO = 1.1;
const BUCKETS = 140; // the last bucket starts above 4 minutes
const LOG_RATIO = Math.log(RATIO);

export function createHistogram(counts) {
  const valid = Array.isArray(counts) && counts.length === BUCKETS;
  const h = { counts: valid ? counts.slice() : new Array(BUCKETS).fill(0), total: 0 };
  for (const n of h.counts) h.total += n;
  return h;
}

// Bucket 0 holds everything up to MIN_MS; bucket i holds (MIN_MS*RATIO^(i-1), MIN_MS*RATIO^i].
function bucketOf(ms) {
  if (!(ms > MIN_MS)) return 0;
  return Math.min(BUCKETS - 1, Math.ceil(Math.log(ms / MIN_MS) / LOG_RATIO - 1e-9));
}

export function addValue(h, ms) {
  h.counts[bucketOf(ms)]++;
  h.total++;
}

// quantile returns the middle of the bucket holding the q-quantile, or null when empty.
export function quantile(h, q) {
  if (!h.total) return null;
  const rank = Math.max(1, Math.ceil(q * h.total));
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    seen += h.counts[i];
    if (seen >= rank) return i === 0 ? MIN_MS : MIN_MS * RATIO ** (i - 0.5);
  }
  return null;
}
