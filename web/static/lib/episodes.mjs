// SPDX-License-Identifier: AGPL-3.0-or-later

// Grouping of failed requests into episodes. A target that fails on and off,
// as when one of several backends is dead, would otherwise fill the log with
// one line per failure. An episode starts with the first burst of failures and
// ends once EPISODE_QUIET_MS has passed without another. Pure logic; the Go
// side does the same for the internal targets (internal/probe/target.go).

export const EPISODE_QUIET_MS = 10_000;

export function createEpisodes() {
  return { current: null };
}

// addBurst adds one burst of failures ({ startedAt, t, failures, classes }, a
// tracker "blip") and returns { opened, closed }: whether it started a new
// episode, and the episode it ended by coming after the quiet time, if any.
// The running episode is holder.current:
//   { start, end, failures, bursts, classes }, end being when it last recovered.
export function addBurst(holder, burst) {
  const closed = settle(holder, burst.startedAt);
  const opened = !holder.current;
  if (opened) holder.current = { start: burst.startedAt, end: burst.t, failures: 0, bursts: 0, classes: {} };
  const ep = holder.current;
  ep.end = burst.t;
  ep.failures += burst.failures;
  ep.bursts++;
  for (const [cls, n] of Object.entries(burst.classes)) ep.classes[cls] = (ep.classes[cls] || 0) + n;
  return { opened, closed };
}

// settle ends the running episode if it has been quiet for long enough at
// time now, and returns it; otherwise null.
export function settle(holder, now) {
  const ep = holder.current;
  if (!ep || now - ep.end <= EPISODE_QUIET_MS) return null;
  holder.current = null;
  return ep;
}
