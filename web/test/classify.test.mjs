// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isFailure, tileState, failureLabel, CLASSES } from '../static/lib/classify.mjs';

const SLOW_MS = 500;

test('classify', async (t) => {
  const cases = [
    ['fast 200', { status: 200, latencyMs: 12 }, 'ok'],
    ['exactly at the slow threshold', { status: 200, latencyMs: 500 }, 'ok'],
    ['over the slow threshold', { status: 200, latencyMs: 501 }, 'slow'],
    ['204', { status: 204, latencyMs: 5 }, 'ok'],
    ['500', { status: 500, latencyMs: 5 }, 'http_5xx'],
    ['503 from the router', { status: 503, latencyMs: 5 }, 'http_5xx'],
    ['slow 503 is still 5xx', { status: 503, latencyMs: 900 }, 'http_5xx'],
    ['404', { status: 404, latencyMs: 5 }, 'http_other'],
    ['302', { status: 302, latencyMs: 5 }, 'http_other'],
    ['opaque response', { status: 0, latencyMs: 5 }, 'http_other'],
    ['200 that is not ping JSON', { status: 200, latencyMs: 5, badBody: true }, 'http_other'],
    ['timeout', { timedOut: true }, 'timeout'],
    ['network error', { networkError: true }, 'network_error'],
  ];
  for (const [name, outcome, want] of cases) {
    await t.test(name, () => assert.equal(classify(outcome, SLOW_MS), want));
  }
});

test('every class has a failure verdict and a tile state', () => {
  const failures = CLASSES.filter(isFailure);
  assert.deepEqual(failures, ['http_5xx', 'http_other', 'timeout', 'network_error']);
  assert.deepEqual(CLASSES.map(tileState), ['green', 'amber', 'red', 'red', 'red', 'red']);
  assert.equal(tileState(null), 'idle');
});

test('failures are counted by their exact status when there is one', () => {
  assert.equal(failureLabel('http_5xx', 503), 'http_503');
  assert.equal(failureLabel('http_other', 404), 'http_404');
  assert.equal(failureLabel('http_other', 0), 'http_other');
  assert.equal(failureLabel('timeout', undefined), 'timeout');
  assert.equal(failureLabel('network_error', undefined), 'network_error');
});
