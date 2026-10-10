// SPDX-License-Identifier: AGPL-3.0-or-later

// Merging of the internal probe reports. Every pod reports what it sees from
// inside the cluster (/api/internal); the browser collects one report per pod
// through whichever external target is up and lays them side by side. Pure logic.

// "Recent" is the last few seconds of a mini graph; what a cell's label and
// the verdict go by, so that a target failing on and off does not flicker.
const RECENT_SECONDS = 10;
// This many failed requests in the recent seconds make "some requests fail" a
// level of its own; fewer is a glitch that only the log records.
export const FAILING_MIN = 3;

// A pod whose report has not been refreshed for this long is stale. That is
// expected when its node dies, and it is shown, not hidden.
export const STALE_MS = 15_000;

// Endpoint changes seen by different pods within this time are the same change.
const SAME_CHANGE_MS = 3000;
const MAX_CHANGES_REMEMBERED = 200;

export function createInternalStore() {
  return {
    reporters: new Map(), // reporting pod -> { report, receivedAt }
    changes: [],          // endpoint changes already handed out
  };
}

// Rows from top to bottom in order of what matters most: does the Service
// answer, then each pod, then the API server. The order never changes.
function rowRank(row) {
  if (row.kind === 'service') return row.mode === 'fresh' ? 0 : 1;
  return row.kind === 'pod' ? 2 : 3;
}

export function targetLabel(target) {
  if (target.kind === 'service') {
    return target.mode === 'keepalive' ? 'Service, kept-alive connection' : 'Service, new connection each time';
  }
  if (target.kind === 'apiserver') return 'API server, through its Service';
  return `Pod ${target.pod || target.podIP}`;
}

// ingest stores a report and returns what is new in it:
//   incidents: every outage and degraded period the report lists, each with a
//              key that is stable across reports, so the caller can add or update
//   changes:   endpoint changes not seen before, from this or another pod
// An older pod reporting from the same node is replaced: it was restarted.
export function ingest(store, report, now) {
  for (const [pod, r] of store.reporters) {
    if (pod !== report.pod && r.report.node === report.node && r.report.startedAt <= report.startedAt) {
      store.reporters.delete(pod);
    }
  }
  store.reporters.set(report.pod, { report, receivedAt: now });

  const incidents = [];
  for (const target of report.targets) {
    for (const incident of target.incidents) {
      incidents.push({
        key: `${report.pod}|${target.id}|${incident.type}|${incident.start}`,
        reporterPod: report.pod,
        reporterNode: report.node,
        targetId: target.id,
        kind: target.kind,
        retry: Boolean(report.retry),
        label: targetLabel(target),
        self: Boolean(target.self),
        ...incident,
      });
    }
  }

  const changes = [];
  for (const change of report.endpoints.changes) {
    const known = store.changes.some((c) => c.ip === change.ip && c.ready === change.ready
      && Math.abs(c.t - change.t) <= SAME_CHANGE_MS);
    if (known) continue;
    store.changes.push(change);
    changes.push({ ...change, pod: podName(store, change.ip) });
  }
  if (store.changes.length > MAX_CHANGES_REMEMBERED) {
    store.changes.splice(0, store.changes.length - MAX_CHANGES_REMEMBERED);
  }
  return { incidents, changes };
}

// sumSpark adds up the last `seconds` seconds of a mini graph; null without one.
function sumSpark(spark, seconds) {
  if (!spark) return null;
  const n = spark.requests.length;
  const sum = { requests: 0, failures: 0, recovered: 0 };
  for (let i = Math.max(0, n - seconds); i < n; i++) {
    sum.requests += spark.requests[i];
    sum.failures += spark.failures[i];
    sum.recovered += spark.recovered[i];
  }
  return sum;
}

// cellView is what one cell shows: the pod's own view of one target right now.
// A target that failed in the last few seconds is "failing" even if its very
// latest request happened to be answered.
export function cellView(cell, kind) {
  if (cell.state === 'idle') return { state: 'idle', label: 'waiting' };
  // One pod's view is not an outage of the cluster: say what that pod sees.
  if (cell.state === 'outage') return { state: 'red', label: kind === 'pod' ? 'unreachable' : 'no answer' };
  if (cell.state === 'failing' || cell.recent?.failures > 0) return { state: 'amber', label: 'failing' };
  if (cell.state === 'degraded' || cell.state === 'slow') return { state: 'amber', label: cell.state };
  return { state: 'green', label: 'ok' };
}

// podName finds the name of the pod behind an IP in what the reporters know.
export function podName(store, ip) {
  for (const { report } of store.reporters.values()) {
    if (report.podIP === ip) return report.pod;
    const target = report.targets.find((t) => t.podIP === ip && t.pod);
    if (target) return target.pod;
  }
  return null;
}

// buildMatrix lays the reports side by side: one column per reporting pod
// (ordered by node), one row per internal target.
//
// A pod row carries a verdict that compares "does the pod answer" with "does
// the Service send it traffic":
//   'dead-in-endpoints'  nobody else reaches it, yet it is still a ready endpoint:
//                        the Service keeps sending requests to a dead pod
//   'alive-not-in-endpoints'  it answers, but is not a ready endpoint: alive but
//                        out of rotation, as during a graceful shutdown
export function buildMatrix(store, now) {
  const columns = [...store.reporters.values()]
    .map(({ report, receivedAt }) => ({
      pod: report.pod,
      node: report.node,
      podIP: report.podIP,
      startedAt: report.startedAt,
      ageMs: now - receivedAt,
      stale: now - receivedAt > STALE_MS,
      endpointsKnown: report.endpoints.watching && report.endpoints.synced && report.endpoints.connected,
      retry: Boolean(report.retry),
      serverTime: report.serverTime,
      // Each target with its mini-graph data and what that adds up to.
      targets: new Map(report.targets.map((t) => {
        const spark = report.sparks?.[t.id] ?? null;
        return [t.id, { ...t, spark, recent: sumSpark(spark, RECENT_SECONDS), minute: sumSpark(spark, Infinity) }];
      })),
    }))
    .sort((a, b) => a.node.localeCompare(b.node) || a.pod.localeCompare(b.pod));

  // Fresh reports decide which rows exist; if every report is stale, show what they last said.
  const fresh = columns.filter((c) => !c.stale);
  const deciding = fresh.length ? fresh : columns;
  const rowTargets = new Map();
  for (const column of deciding) {
    for (const target of column.targets.values()) {
      if (target.kind === 'pod' && !target.active) continue;
      const known = rowTargets.get(target.id);
      // Prefer a description that knows the pod's name.
      if (!known || (!known.pod && target.pod)) rowTargets.set(target.id, target);
    }
  }

  const rows = [...rowTargets.values()].map((target) => {
    const cells = columns.map((column) => column.targets.get(target.id) ?? null);
    const row = {
      id: target.id,
      kind: target.kind,
      mode: target.mode,
      label: targetLabel(target),
      podIP: target.podIP ?? null,
      node: target.node ?? null,
      inEndpoints: null,
      verdict: null,
      cells,
    };
    if (target.kind === 'pod') {
      // What others see counts; a pod reaching itself says little.
      const views = columns
        .map((column, i) => ({ column, cell: cells[i] }))
        .filter(({ column, cell }) => cell && !column.stale && !cell.self && cell.state !== 'idle');
      const answer = views.find(({ column, cell }) => column.endpointsKnown && cell.inEndpoints != null);
      row.inEndpoints = answer ? answer.cell.inEndpoints : null;
      const reached = views.filter(({ cell }) => cell.state !== 'outage').length;
      if (views.length && reached === 0 && row.inEndpoints === true) row.verdict = 'dead-in-endpoints';
      else if (reached > 0 && row.inEndpoints === false) row.verdict = 'alive-not-in-endpoints';
    }
    return row;
  }).sort((a, b) => rowRank(a) - rowRank(b)
    || (a.kind === 'pod' ? (a.node ?? '').localeCompare(b.node ?? '') : 0)
    || a.id.localeCompare(b.id));

  return { columns, rows };
}

const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// assessNodes says, for every node, whether its pod reports and whether the
// pods on the other nodes can reach it. When a node is down, this is where the
// others' agreement about it shows.
//   status: 'ok' | 'degraded' | 'down'
function assessNodes(columns, rows) {
  const names = new Set();
  for (const c of columns) if (c.node) names.add(c.node);
  for (const r of rows) if (r.kind === 'pod' && r.node) names.add(r.node);

  return [...names].sort().map((node) => {
    const mine = columns.filter((c) => c.node === node);
    const reporting = mine.some((c) => !c.stale);
    const reached = new Set();
    const unreached = new Set();
    let stillSentRequests = false;
    for (const row of rows) {
      if (row.kind !== 'pod' || row.node !== node) continue;
      if (row.verdict === 'dead-in-endpoints') stillSentRequests = true;
      row.cells.forEach((cell, i) => {
        const from = columns[i];
        if (!cell || cell.self || from.stale || cell.state === 'idle') return;
        (cell.state === 'outage' ? unreached : reached).add(from.node);
      });
    }
    for (const n of reached) unreached.delete(n);
    const cannot = `${list([...unreached].sort())} cannot reach its pod`;

    let status = 'ok';
    let text = reached.size ? 'its pod reports, and the others reach it' : 'its pod reports';
    if (!reporting && !reached.size) {
      status = 'down';
      text = unreached.size ? `not reachable: ${cannot}, and it has stopped reporting` : 'no pod on it reports or is known to the others';
    } else if (!reporting) {
      status = 'degraded';
      text = 'the others reach its pod, but its own report is not arriving';
    } else if (unreached.size) {
      status = 'degraded';
      text = reached.size ? `it reports, but ${cannot}` : `it reports, but ${cannot}: it is cut off from the others`;
    }
    if (stillSentRequests) text += '; the Service still sends it requests';
    return { node, status, text };
  });
}

// assess turns the matrix into one verdict for the inside of the cluster.
//   'ok'        every expected pod reports, they all reach each other, and the
//               Service answers for all of them
//   'degraded'  something is missing, but the Service still answers for at
//               least one reporting pod
//   'failing'   the Service answers, but some of the requests to it fail, as
//               when it still sends requests to a pod that is gone
//   'outage'    no reporting pod gets an answer from the Service
//   'unknown'   no report is arriving, so the inside cannot be seen from here
// A single pod's failed requests change nothing here: only what a pod firmly
// reports (no answer for failThreshold requests in a row) counts.
export function assess({ columns, rows }, expectedReplicas) {
  const nodes = assessNodes(columns, rows);
  if (!columns.length) return { status: 'unknown', reasons: ['no pod has reported yet'], nodes };
  const fresh = columns.map((column, i) => ({ column, i })).filter(({ column }) => !column.stale);
  if (!fresh.length) {
    return { status: 'unknown', reasons: ['no pod is reporting, so the inside of the cluster cannot be seen from here'], nodes };
  }

  const serviceRows = rows.filter((r) => r.kind === 'service');
  let judged = 0;
  let answered = 0;
  for (const { i } of fresh) {
    const cells = serviceRows.map((r) => r.cells[i]).filter((cell) => cell && cell.state !== 'idle');
    if (!cells.length) continue;
    judged++;
    if (cells.some((cell) => cell.state !== 'outage')) answered++;
  }
  if (judged && !answered) {
    return { status: 'outage', reasons: ['no reporting pod gets an answer from the Service'], nodes };
  }

  const reasons = [];
  const failing = failingService(serviceRows, fresh);
  if (failing) reasons.push(failing);
  if (fresh.length < expectedReplicas) {
    reasons.push(`${fresh.length} of ${expectedReplicas} pods ${fresh.length === 1 ? 'is' : 'are'} reporting`);
  }
  for (const row of serviceRows) {
    const from = fresh.filter(({ i }) => row.cells[i]?.state === 'outage').map(({ column }) => column.node).sort();
    if (from.length) {
      reasons.push(`the Service does not answer ${row.mode === 'keepalive' ? 'on the kept-alive connection' : 'new connections'} from ${list(from)}`);
    }
  }
  if (serviceRows.some((row) => fresh.some(({ i }) => row.cells[i]?.state === 'degraded'))) {
    reasons.push(`fewer than ${expectedReplicas} pods answer through the Service`);
  }
  for (const n of nodes) {
    if (n.status !== 'ok') reasons.push(`${n.node}: ${n.text}`);
  }
  return { status: failing ? 'failing' : reasons.length ? 'degraded' : 'ok', reasons, nodes };
}

// failingService says, in words that stay the same from one second to the
// next, how much of the traffic to the Service fails and whether a retry helps.
function failingService(serviceRows, fresh) {
  const sum = { requests: 0, failures: 0, recovered: 0 };
  const from = new Set();
  let retried = false;
  for (const row of serviceRows) {
    for (const { column, i } of fresh) {
      const recent = row.cells[i]?.recent;
      if (!recent || recent.failures < FAILING_MIN) continue;
      from.add(column.node);
      retried ||= column.retry;
      for (const key of Object.keys(sum)) sum[key] += recent[key];
    }
  }
  if (!from.size) return null;
  const share = sum.failures / sum.requests;
  const howMany = share < 0.15 ? 'a few' : share < 0.42 ? 'about a third of the' : share < 0.6 ? 'about half of the' : 'most';
  let text = `${howMany} requests to the Service fail, seen from ${list([...from].sort())}`;
  if (retried) {
    const helped = sum.recovered / sum.failures;
    const forWhom = helped === 1 ? 'all' : helped >= 0.6 ? 'most' : helped > 0 ? 'some' : 'none';
    text += `; a retry on a new connection succeeds for ${forWhom} of them`;
  }
  return text;
}
