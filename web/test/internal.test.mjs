// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInternalStore, ingest, buildMatrix, assess, cellView, podName, targetLabel, STALE_MS,
} from '../static/lib/internal.mjs';

const NODES = { a: 'node-1', b: 'node-2', c: 'node-3' };
const IPS = { a: '10.0.0.1', b: '10.0.0.2', c: '10.0.0.3' };

function target(id, extra = {}) {
  const [kind, ip, mode] = id.startsWith('pod/') ? id.split('/') : [id.split('/')[0], null, id.split('/')[1] ?? 'fresh'];
  return {
    id, kind, mode, url: 'http://x', active: true, inEndpoints: kind === 'pod' ? true : null,
    state: 'ok', outageSince: null, counters: { requests: 10, failures: 0, outages: 0, downtimeMs: 0, longestOutageMs: 0 },
    last: { t: 1, class: 'ok', latencyMs: 1.5 }, incidents: [],
    ...(ip ? { podIP: ip } : {}),
    ...extra,
  };
}

// report builds what pod `who` (a, b or c) would send; overrides replace targets by id.
function report(who, overrides = {}, extra = {}) {
  const targets = [
    target('apiserver'),
    ...['a', 'b', 'c'].map((p) => target(`pod/${IPS[p]}/fresh`, { pod: `pod-${p}`, node: NODES[p], self: p === who })),
    target('service/fresh'),
    target('service/keepalive'),
  ].map((t) => ({ ...t, ...overrides[t.id] }));
  return {
    pod: `pod-${who}`, node: NODES[who], podIP: IPS[who], serverTime: 0, startedAt: 1000,
    endpoints: { watching: true, synced: true, connected: true, changes: [] },
    targets,
    ...extra,
  };
}

test('one column per reporting pod, ordered by node; rows ordered service, pods, API server', () => {
  const store = createInternalStore();
  for (const who of ['c', 'a', 'b']) ingest(store, report(who), 5000);
  const m = buildMatrix(store, 6000);
  assert.deepEqual(m.columns.map((c) => c.node), ['node-1', 'node-2', 'node-3']);
  assert.deepEqual(m.columns.map((c) => c.stale), [false, false, false]);
  assert.equal(m.columns[0].ageMs, 1000);
  assert.deepEqual(m.rows.map((r) => r.id), [
    'service/fresh', 'service/keepalive',
    'pod/10.0.0.1/fresh', 'pod/10.0.0.2/fresh', 'pod/10.0.0.3/fresh',
    'apiserver',
  ]);
  assert.equal(m.rows[0].label, 'Service, new connection each time');
  assert.equal(m.rows[2].label, 'Pod pod-a');
  assert.equal(m.rows[2].cells[0].self, true);
  assert.equal(m.rows[2].inEndpoints, true);
  assert.equal(m.rows[2].verdict, null);
  assert.equal(m.rows[5].inEndpoints, null);
});

test('a pod that stops reporting goes stale and stays visible', () => {
  const store = createInternalStore();
  ingest(store, report('a'), 0);
  ingest(store, report('b'), 0);
  ingest(store, report('a'), STALE_MS + 1000);
  const m = buildMatrix(store, STALE_MS + 1000);
  assert.deepEqual(m.columns.map((c) => [c.node, c.stale]), [['node-1', false], ['node-2', true]]);
  assert.equal(m.rows.length, 6);
});

test('a restarted pod replaces the old one on its node', () => {
  const store = createInternalStore();
  ingest(store, report('a'), 0);
  ingest(store, report('b'), 0);
  ingest(store, { ...report('b'), pod: 'pod-b2', startedAt: 9000 }, 100);
  assert.deepEqual([...store.reporters.keys()], ['pod-a', 'pod-b2']);
  // A late report from the old pod must not push the new one out.
  ingest(store, report('b'), 200);
  assert.deepEqual([...store.reporters.keys()].sort(), ['pod-a', 'pod-b', 'pod-b2']);
  ingest(store, { ...report('b'), pod: 'pod-b2', startedAt: 9000 }, 300);
  assert.deepEqual([...store.reporters.keys()], ['pod-a', 'pod-b2']);
});

test('dead but still in endpoints: the dangerous case', () => {
  const store = createInternalStore();
  const dead = { [`pod/${IPS.c}/fresh`]: { state: 'outage', outageSince: 4000, inEndpoints: true } };
  ingest(store, report('a', dead), 5000);
  ingest(store, report('b', dead), 5000);
  // pod-c itself reported before its node died; that report is stale now.
  ingest(store, report('c'), 5000 - STALE_MS - 1);
  const row = buildMatrix(store, 5000).rows.find((r) => r.podIP === IPS.c);
  assert.equal(row.verdict, 'dead-in-endpoints');
  assert.equal(row.inEndpoints, true);

  // Once the endpoint is pulled it is simply down.
  const removed = { [`pod/${IPS.c}/fresh`]: { state: 'outage', outageSince: 4000, inEndpoints: false } };
  ingest(store, report('a', removed), 6000);
  ingest(store, report('b', removed), 6000);
  assert.equal(buildMatrix(store, 6000).rows.find((r) => r.podIP === IPS.c).verdict, null);
});

test('a pod that only reaches itself is still dead to the others', () => {
  const store = createInternalStore();
  const dead = { [`pod/${IPS.c}/fresh`]: { state: 'outage', inEndpoints: true } };
  ingest(store, report('a', dead), 0);
  ingest(store, report('b', dead), 0);
  ingest(store, report('c'), 0); // its self-probe says ok
  assert.equal(buildMatrix(store, 0).rows.find((r) => r.podIP === IPS.c).verdict, 'dead-in-endpoints');
});

test('alive but not in endpoints: out of rotation', () => {
  const store = createInternalStore();
  const draining = { [`pod/${IPS.b}/fresh`]: { inEndpoints: false } };
  for (const who of ['a', 'b', 'c']) ingest(store, report(who, draining), 0);
  const row = buildMatrix(store, 0).rows.find((r) => r.podIP === IPS.b);
  assert.equal(row.verdict, 'alive-not-in-endpoints');
  assert.equal(row.inEndpoints, false);
});

test('no verdict when the endpoint state is not known', () => {
  const store = createInternalStore();
  const dead = { [`pod/${IPS.c}/fresh`]: { state: 'outage', inEndpoints: true } };
  const disconnected = { endpoints: { watching: true, synced: true, connected: false, changes: [] } };
  ingest(store, report('a', dead, disconnected), 0);
  const row = buildMatrix(store, 0).rows.find((r) => r.podIP === IPS.c);
  assert.equal(row.inEndpoints, null);
  assert.equal(row.verdict, null);
});

test('pods that left the headless Service drop out of the rows', () => {
  const store = createInternalStore();
  ingest(store, report('a', { [`pod/${IPS.c}/fresh`]: { active: false } }), 0);
  assert.deepEqual(buildMatrix(store, 0).rows.filter((r) => r.kind === 'pod').map((r) => r.podIP), [IPS.a, IPS.b]);
});

test('incidents get keys that are stable across reports', () => {
  const store = createInternalStore();
  const open = { type: 'outage', start: 4000, end: null, durationMs: null };
  const first = ingest(store, report('a', { 'service/fresh': { incidents: [open] } }), 0);
  assert.equal(first.incidents.length, 1);
  assert.deepEqual(
    { key: first.incidents[0].key, node: first.incidents[0].reporterNode, label: first.incidents[0].label, end: first.incidents[0].end },
    { key: 'pod-a|service/fresh|outage|4000', node: 'node-1', label: 'Service, new connection each time', end: null },
  );
  const closed = { ...open, end: 4600, durationMs: 600, failures: 3, classes: { conn_refused: 3 } };
  const second = ingest(store, report('a', { 'service/fresh': { incidents: [closed] } }), 100);
  assert.equal(second.incidents[0].key, first.incidents[0].key);
  assert.equal(second.incidents[0].durationMs, 600);
  // The same incident seen from another pod is a different entry: the vantage point matters.
  const other = ingest(store, report('b', { 'service/fresh': { incidents: [closed] } }), 100);
  assert.notEqual(other.incidents[0].key, first.incidents[0].key);
});

test('an endpoint change reported by several pods is handed out once', () => {
  const store = createInternalStore();
  const changes = (t) => ({ endpoints: { watching: true, synced: true, connected: true, changes: [{ t, ip: IPS.c, ready: false }] } });
  assert.deepEqual(ingest(store, report('a', {}, changes(5000)), 0).changes, [{ t: 5000, ip: IPS.c, ready: false, pod: 'pod-c' }]);
  assert.deepEqual(ingest(store, report('b', {}, changes(5040)), 0).changes, []);
  assert.deepEqual(ingest(store, report('a', {}, changes(5000)), 0).changes, []);
  // The same pod becoming not ready again much later is a new change.
  assert.equal(ingest(store, report('a', {}, changes(60_000)), 0).changes.length, 1);
});

test('podName and targetLabel', () => {
  const store = createInternalStore();
  ingest(store, report('a'), 0);
  assert.equal(podName(store, IPS.a), 'pod-a');
  assert.equal(podName(store, IPS.b), 'pod-b');
  assert.equal(podName(store, '10.9.9.9'), null);
  assert.equal(targetLabel({ kind: 'pod', podIP: '10.9.9.9' }), 'Pod 10.9.9.9');
  assert.equal(targetLabel({ kind: 'service', mode: 'keepalive' }), 'Service, kept-alive connection');
  assert.equal(targetLabel({ kind: 'apiserver' }), 'API server, through its Service');
});

// ---- the verdict for the inside of the cluster ----

const dead = (who, extra = {}) => ({ [`pod/${IPS[who]}/fresh`]: { state: 'outage', inEndpoints: false, ...extra } });

function verdict(store, now = 0) {
  return assess(buildMatrix(store, now), 3);
}

test('row order is fixed whichever node answered last', () => {
  const store = createInternalStore();
  ingest(store, report('a', { 'service/fresh': { node: 'node-3' }, 'service/keepalive': { node: 'node-1' } }), 0);
  const first = buildMatrix(store, 0).rows.map((r) => r.id);
  ingest(store, report('a', { 'service/fresh': { node: 'node-1' }, 'service/keepalive': { node: 'node-3' } }), 0);
  assert.deepEqual(buildMatrix(store, 0).rows.map((r) => r.id), first);
  assert.deepEqual(first.slice(0, 2), ['service/fresh', 'service/keepalive']);
  assert.equal(first.at(-1), 'apiserver');
});

test('inside is ok when every pod reports, reaches the others and gets answers', () => {
  const store = createInternalStore();
  for (const who of ['a', 'b', 'c']) ingest(store, report(who), 0);
  const v = verdict(store);
  assert.equal(v.status, 'ok');
  assert.deepEqual(v.reasons, []);
  assert.deepEqual(v.nodes.map((n) => [n.node, n.status]), [['node-1', 'ok'], ['node-2', 'ok'], ['node-3', 'ok']]);
});

test('one node off: degraded, not an outage, and the others agree which node it is', () => {
  const store = createInternalStore();
  ingest(store, report('c'), 0); // node-3 reported, then went dark
  const now = STALE_MS + 5000;
  ingest(store, report('a', dead('c')), now);
  ingest(store, report('b', dead('c')), now);
  const v = verdict(store, now);
  assert.equal(v.status, 'degraded');
  assert.deepEqual(v.nodes.map((n) => [n.node, n.status]), [['node-1', 'ok'], ['node-2', 'ok'], ['node-3', 'down']]);
  assert.equal(v.nodes[2].text, 'not reachable: node-1 and node-2 cannot reach its pod, and it has stopped reporting');
  assert.deepEqual(v.reasons, [
    '2 of 3 pods are reporting',
    'node-3: not reachable: node-1 and node-2 cannot reach its pod, and it has stopped reporting',
  ]);
});

test('a dead pod that is still an endpoint is called out on its node', () => {
  const store = createInternalStore();
  ingest(store, report('a', dead('c', { inEndpoints: true })), 0);
  ingest(store, report('b', dead('c', { inEndpoints: true })), 0);
  const node3 = verdict(store).nodes.find((n) => n.node === 'node-3');
  assert.equal(node3.status, 'down');
  assert.match(node3.text, /the Service still sends it requests$/);
});

test('failed requests seen by one pod are not an outage', () => {
  const store = createInternalStore();
  const failing = { 'service/fresh': { state: 'failing', counters: { requests: 100, failures: 1, outages: 0, downtimeMs: 0, longestOutageMs: 0 } } };
  ingest(store, report('a', failing), 0);
  ingest(store, report('b'), 0);
  ingest(store, report('c'), 0);
  assert.equal(verdict(store).status, 'ok');
});

test('the Service not answering for one pod is degraded, with the node named', () => {
  const store = createInternalStore();
  ingest(store, report('a', { 'service/fresh': { state: 'outage' } }), 0);
  ingest(store, report('b'), 0);
  ingest(store, report('c'), 0);
  const v = verdict(store);
  assert.equal(v.status, 'degraded');
  assert.deepEqual(v.reasons, ['the Service does not answer new connections from node-1']);
});

test('one pod left is degraded as long as the Service answers it', () => {
  const store = createInternalStore();
  ingest(store, report('a', { ...dead('b'), ...dead('c') }), 0);
  const v = verdict(store);
  assert.equal(v.status, 'degraded');
  assert.equal(v.reasons[0], '1 of 3 pods is reporting');
  assert.deepEqual(v.nodes.map((n) => n.status), ['ok', 'down', 'down']);
});

test('outage only when no reporting pod gets an answer from the Service', () => {
  const store = createInternalStore();
  const noService = { 'service/fresh': { state: 'outage' }, 'service/keepalive': { state: 'outage' } };
  ingest(store, report('a', noService), 0);
  ingest(store, report('b', noService), 0);
  ingest(store, report('c', { 'service/fresh': { state: 'outage' } }), 0);
  assert.equal(verdict(store).status, 'degraded', 'one pod still gets answers on its kept-alive connection');
  ingest(store, report('c', noService), 0);
  const v = verdict(store);
  assert.equal(v.status, 'outage');
  assert.deepEqual(v.reasons, ['no reporting pod gets an answer from the Service']);
});

test('the API server failing does not change the verdict', () => {
  const store = createInternalStore();
  for (const who of ['a', 'b', 'c']) ingest(store, report(who, { apiserver: { state: 'outage' } }), 0);
  assert.equal(verdict(store).status, 'ok');
});

test('unknown when no report arrives', () => {
  const store = createInternalStore();
  assert.equal(verdict(store).status, 'unknown');
  ingest(store, report('a'), 0);
  const v = verdict(store, STALE_MS + 1);
  assert.equal(v.status, 'unknown');
  assert.match(v.reasons[0], /cannot be seen from here/);
});

test('incidents carry the kind of their target', () => {
  const store = createInternalStore();
  const blip = { type: 'blip', start: 1, end: 200, durationMs: 199, failures: 1, classes: { timeout: 1 } };
  const { incidents } = ingest(store, report('a', { 'service/fresh': { incidents: [blip] }, [`pod/${IPS.b}/fresh`]: { incidents: [blip] } }), 0);
  assert.deepEqual(incidents.map((i) => [i.kind, i.type]), [['pod', 'blip'], ['service', 'blip']]);
});

// ---- some requests fail: a level of its own ----

// spark builds a 60 s mini graph where, in each of the last `seconds` seconds,
// `failures` of 5 requests fail and `recovered` of those succeed on a retry.
function spark(seconds, failures, recovered = 0) {
  const n = 60;
  const fill = (v) => Array.from({ length: n }, (_, i) => (i >= n - seconds ? v : 0));
  return {
    start: 0, latencyMs: new Array(n).fill(2), requests: new Array(n).fill(5), failures: fill(failures), recovered: fill(recovered),
  };
}

test('a third of Service requests failing is "failing", above degraded and below outage', () => {
  const store = createInternalStore();
  const sparks = { sparks: { 'service/fresh': spark(30, 2, 2) }, retry: true };
  ingest(store, report('a', dead('c', { inEndpoints: true }), sparks), 0);
  ingest(store, report('b', dead('c', { inEndpoints: true }), sparks), 0);
  const v = verdict(store);
  assert.equal(v.status, 'failing');
  assert.equal(v.reasons[0], 'about a third of the requests to the Service fail, seen from node-1 and node-2; a retry on a new connection succeeds for all of them');
  assert.ok(v.reasons.length > 1, 'what is missing is still listed after it');
});

test('how much fails and whether a retry helps is put in steady words', () => {
  const cases = [
    [[30, 1, 0], false, 'about a third of the requests to the Service fail, seen from node-1'],
    [[30, 3, 2], true, 'most requests to the Service fail, seen from node-1; a retry on a new connection succeeds for most of them'],
    [[30, 5, 0], true, 'most requests to the Service fail, seen from node-1; a retry on a new connection succeeds for none of them'],
    [[2, 2, 1], true, 'a few requests to the Service fail, seen from node-1; a retry on a new connection succeeds for some of them'],
  ];
  for (const [args, retry, want] of cases) {
    const store = createInternalStore();
    ingest(store, report('a', {}, { sparks: { 'service/fresh': spark(...args) }, retry }), 0);
    ingest(store, report('b'), 0);
    ingest(store, report('c'), 0);
    const v = verdict(store);
    assert.equal(v.status, 'failing');
    assert.equal(v.reasons[0], want);
  }
});

test('one or two failed requests are a glitch, not a level', () => {
  const store = createInternalStore();
  ingest(store, report('a', {}, { sparks: { 'service/fresh': spark(1, 2) } }), 0);
  ingest(store, report('b'), 0);
  ingest(store, report('c'), 0);
  assert.equal(verdict(store).status, 'ok');
});

test('failed requests to the API server or to a pod do not make the inside "failing"', () => {
  const store = createInternalStore();
  const sparks = { sparks: { apiserver: spark(30, 2), [`pod/${IPS.b}/fresh`]: spark(30, 5) } };
  for (const who of ['a', 'b', 'c']) ingest(store, report(who, {}, sparks), 0);
  assert.equal(verdict(store).status, 'ok');
});

test('a cell stays "failing" while failures keep coming, even when the latest request was answered', () => {
  const store = createInternalStore();
  ingest(store, report('a', {}, { sparks: { 'service/fresh': spark(30, 2), 'service/keepalive': spark(0, 0) } }), 0);
  const { rows } = buildMatrix(store, 0);
  const cell = (id) => rows.find((r) => r.id === id).cells[0];
  assert.equal(cell('service/fresh').state, 'ok', 'the pod itself says ok: its latest request was answered');
  assert.deepEqual(cellView(cell('service/fresh'), 'service'), { state: 'amber', label: 'failing' });
  assert.deepEqual(cell('service/fresh').minute, { requests: 300, failures: 60, recovered: 0 });
  assert.deepEqual(cell('service/fresh').recent, { requests: 50, failures: 20, recovered: 0 });
  assert.deepEqual(cellView(cell('service/keepalive'), 'service'), { state: 'green', label: 'ok' });
  assert.equal(cell('apiserver').recent, null, 'no mini graph, no sums');
});

test('cell labels say what one pod sees, never "outage"', () => {
  assert.deepEqual(cellView({ state: 'outage' }, 'pod'), { state: 'red', label: 'unreachable' });
  assert.deepEqual(cellView({ state: 'outage' }, 'service'), { state: 'red', label: 'no answer' });
  assert.deepEqual(cellView({ state: 'degraded' }, 'service'), { state: 'amber', label: 'degraded' });
  assert.deepEqual(cellView({ state: 'idle' }, 'service'), { state: 'idle', label: 'waiting' });
});
