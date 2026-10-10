// SPDX-License-Identifier: AGPL-3.0-or-later

// Classification of one browser probe. Pure logic, shared by the SPA and the
// node unit tests (web/test).

export const CLASSES = ['ok', 'slow', 'http_5xx', 'http_other', 'timeout', 'network_error'];

// A probe outcome is one of:
//   { timedOut: true }             aborted by our own timeout
//   { networkError: true }         fetch() rejected: DNS, TLS, connection refused/reset or CORS;
//                                  the browser does not tell these apart
//   { status, latencyMs, badBody } a response arrived; badBody when a 2xx body was not ping JSON
export function classify(outcome, slowMs) {
  if (outcome.timedOut) return 'timeout';
  if (outcome.networkError) return 'network_error';
  const { status, latencyMs, badBody } = outcome;
  if (status >= 500 && status <= 599) return 'http_5xx';
  if (!(status >= 200 && status <= 299) || badBody) return 'http_other';
  return latencyMs > slowMs ? 'slow' : 'ok';
}

// A slow answer is still an answer; everything else counts as a failure.
export function isFailure(cls) {
  return cls !== 'ok' && cls !== 'slow';
}

// Tile state for the most recent result: 'green', 'amber', 'red', or 'idle' before any result.
export function tileState(cls) {
  if (!cls) return 'idle';
  if (cls === 'ok') return 'green';
  if (cls === 'slow') return 'amber';
  return 'red';
}
