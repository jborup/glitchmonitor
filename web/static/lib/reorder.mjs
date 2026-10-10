// SPDX-License-Identifier: AGPL-3.0-or-later

// Probes are sent on a fixed schedule and overlap while a target is slow or
// timing out, so their results arrive out of order. createReorder hands them
// on in send order: result n is held back until 1..n-1 have been delivered.
// Every probe ends within its timeout, so nothing is held longer than that.
export function createReorder(deliver) {
  const waiting = new Map();
  let next = 1;
  return {
    push(seq, result) {
      waiting.set(seq, result);
      while (waiting.has(next)) {
        const r = waiting.get(next);
        waiting.delete(next);
        next++;
        deliver(r);
      }
    },
    get pending() { return waiting.size; },
  };
}
