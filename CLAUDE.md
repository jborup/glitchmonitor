# glitchmonitor — project brief for Claude Code

A demo/measurement app that shows, live in a browser, whether an OpenShift (OCP) cluster has
**any** service disruption during maintenance — rolling restarts, node drains, MachineConfigPool
(MCP) rollouts, OCP upgrades — and how long the outage is when a node fails hard.

The audience sees a single-page dashboard with live tiles, a flash and beep on outages, and
counters that accumulate while the page is open.

## Target environment
- 3-node **compact bare-metal OCP** cluster: control plane and workers on the same 3 nodes.
- Two ways in from outside, **both optional and configurable**:
  - OpenShift Route on `*.apps.<cluster-domain>`
  - Gateway API (HTTPRoute) on `*.gtw.<cluster-domain>`
  - The Route may be disabled entirely in favour of the Gateway.
- No commercial dependencies. Vendor all frontend libraries into the binary: no CDN at runtime, since the cluster may be air-gapped.

## Decisions already made (don't revisit without asking)
1. **One Go binary** that serves an embedded SPA (`go:embed`).
   - Frontend is plain HTML/CSS/JS, no npm and no build step.
   - Charting: uPlot, vendored.
2. **The app runs on the cluster as 3 replicas and is itself the probe target.**
   - It is reached at e.g. `https://glitchmonitor.apps.<domain>` and/or `https://glitchmonitor.gtw.<domain>`.
3. **The browser is the external probe and the dashboard.**
   - All timers, counters and outage state live in browser JS memory.
   - The page loads once and must keep working while the cluster is disrupted.
   - Never require a reload during a test.
4. **Every pod also runs internal probes**, and exposes the results for the browser to merge. Internal targets:
   - the ClusterIP Service
   - each peer pod directly by pod IP, to separate "Service/OVN/endpoint propagation problem" from "pod actually down"
   - the API server's `/readyz`
5. **Planned later, not in the first milestones:** a `probe` subcommand that runs the same probe logic headless on a laptop or VM for unattended recordings, e.g. overnight upgrades. Same codebase.

## Architecture

### Server (`glitchmonitor serve`)
- Downward API env vars: `POD_NAME`, `POD_IP`, `NODE_NAME`, `POD_NAMESPACE`.
- HTTP endpoints:

  | Endpoint | Purpose |
  |---|---|
  | `GET /` | Embedded SPA |
  | `GET /api/config` | Probe targets and thresholds for the browser (from config), plus `about`: version and source URL |
  | `GET /LICENSE` | The licence text, linked from the dashboard footer |
  | `GET /THIRD-PARTY-NOTICES` | The third-party notices and all their licence texts, linked from the footer |
  | `GET /api/ping` | `{pod, node, podIP, serverTime, seq}`; `Cache-Control: no-store`; CORS per config |
  | `GET /api/internal` | This pod's internal probe results: state, counters and recent incidents per target; CORS per config. The ring of raw results (last ~10 min) is only included with `?results=all` or `?since=<epoch ms>`, because it is large and the dashboard polls every second |
  | `GET /healthz` | Liveness |
  | `GET /readyz` | Readiness; returns 503 once SIGTERM is received |

- **CORS:**
  - Allowed origins come from config, so the SPA loaded from the `apps` host can probe the `gtw` host and vice versa.
  - Echo the `Origin` header only when it is allowed.
  - Keep probe requests "simple": GET, no custom headers. That avoids preflight `OPTIONS` requests distorting timings. Still answer `OPTIONS` correctly.
- **Graceful shutdown:**
  1. On SIGTERM, flip readiness to false.
  2. Sleep `shutdownDelay` (configurable, default 5s).
  3. Call `http.Server.Shutdown`.
  - Setting the delay to 0 must be allowed, to *demonstrate* the blips you get without it.

### Internal probes (inside every pod)
**Code layout**
- `internal/probe`: shared probing logic, also meant for the later headless mode: classification, the outage/degraded tracker (the same state machine as `web/static/lib/tracker.mjs`; keep the two and their tests in step), result reordering, and the probe loop.
- `internal/kube`: in-cluster credentials and the EndpointSlice watch, over plain HTTP. **No Kubernetes client library**: it would add a large dependency tree for one list and one watch.
- `internal/internalprobe`: the manager that runs the targets and builds the `/api/internal` report.
- Outside a cluster (`POD_NAMESPACE` unset) no internal probes run and `/api/internal` answers 404; the dashboard then hides the internal view.

**Behaviour**
- Probes go on a fixed schedule and results are applied in send order, as in the browser.
- Counters are per pod and start when the pod starts; they begin again after a restart.
- "Degraded" is judged only for the Service target in `fresh` mode: a kept-alive connection stays on one pod by design.
- A pod-direct target is retired when its IP leaves the headless Service; an outage still running then is ended with the note "the pod is gone".
- While the API server is unreachable the last known endpoint state is kept and reported as not connected.

**Targets**
- **Service target:** `http://glitchmonitor.<ns>.svc:8080/api/ping`
- **Pod-direct targets:**
  - Re-resolve the headless Service `glitchmonitor-peers` (with `publishNotReadyAddresses: true`) every 2s.
  - Probe each pod IP on `/api/ping`. Include self, flagged as self.
- **Endpoint readiness:**
  - Watch EndpointSlices for the Service (namespace-scoped RBAC: get/list/watch `endpointslices`).
  - Each pod-direct result is then tagged "in endpoints: yes/no".
  - This is what lets the UI say "pod alive but already removed from the Service", or "pod dead but still in endpoints", the dangerous one.
- **API server target:** `https://kubernetes.default.svc/readyz`, using the ServiceAccount token and CA.
- **Connection mode** per target, configurable: `keepalive` (reused connection) or `fresh` (new TCP+TLS each request). Default is both for the Service target.
- **Result classes:** `ok`, `slow` (over threshold), `http_5xx`, `http_other`, `timeout_connect`, `timeout_response`, `conn_refused`, `dns_error`, `tls_error`, `other_error`. Each result records timestamp, latency, the HTTP status, and which pod/node answered.
  - **Timeouts are split by phase,** because the two call for different client reactions: `timeout_connect` means the request was never sent (a powered-off node answers nothing; a retry cannot do anything twice), `timeout_response` means it was sent and no answer came (the client cannot know whether the server acted). Every failure also records whether the request had been sent. `timeout` alone is what a browser reports, which cannot tell.
  - `internal.connectTimeoutMs` (default 500) bounds opening the connection, TLS included; `internal.timeoutMs` bounds the whole request.
  - **One retry** (`internal.retry`, default on): a failed probe is tried once more on a new connection, to show what a retrying client would get. The first attempt stays the result and is what counters and the state machine see; the retry's outcome is recorded beside it ("recovered").
  - Failures are counted in the log by exact status where there is one (`http_503`), inside and outside. From outside, a failed answer from the other origin has no CORS headers, so the browser sees it as `network_error`; only the page's own origin shows its status.
- Default interval is 200 ms per target, configurable.

### Browser (SPA)

**Probing**
- For each enabled external target from `/api/config`, `fetch()` `/api/ping` at the configured interval (default 100 ms).
- Use `AbortController` for timeouts, `cache: 'no-store'`, `mode: 'cors'`, and `performance.now()` for timing.
- **One retry** (`browser.retry`, default on): a failed request is sent once more straight away, to show what a web application that retries would get. The first attempt is what the counters and the state machine see, and it is handed on at once so that outage detection is not delayed; the retry's outcome is added afterwards to the tile ("Fine on a retry"), to the log entry the request belongs to, and to the timeline's "failed" lane (yellow where every failure in that second was answered on a retry, red where not). A page cannot make the browser open a new connection, so the retry goes over the existing one to the route or gateway, which then picks a pod again. Splitting timeouts by phase and retrying on a new connection from outside need the headless probe mode.
- Classify each result as `ok`, `slow`, `http_5xx`, `http_other`, `timeout`, or `network_error`. The browser can't tell DNS, TLS and connection-refused apart; say so in the UI help text.
- Pull `/api/internal` every 1–2 s through whichever external target is currently up, and merge the results per reporting pod.
  - If a pod's report stops updating, mark it stale. That is expected when its node dies; show it, don't hide it.
  - Implemented as: every external target that is up is polled once a second; a pod is stale after 15 s without a report; a newer pod on the same node replaces the older one.
  - "Inside the cluster" is laid out from most to least important: the verdict with its reasons; a line per node saying whether its pod reports and whether the others reach it (this is where the pods' agreement about a node that is down shows); then the table, a column per reporting pod (by node) and rows in a fixed order: Service with new connections, Service kept-alive, each pod, API server.
  - A pod row carries a verdict: "down, but the Service still sends it requests" (unreachable for the others, yet a ready endpoint) or "alive, but taken out of the Service".
  - Mini graphs in the cells (a switch, on by default) show the last minute from `?spark=60`, captioned with the two ends, e.g. "node-1 → node-3": a line for the slowest answer per second; a bar for failed requests, as tall as the share that failed, yellow where the retry succeeded and red where it did not; an amber bottom edge while that pod saw fewer pods than expected.
  - Freshness is shown, not assumed: the report's age is under each pod's name and a cell says when its own latest result is old, both in amber past the same 8 s (lower limits were noise: reports routinely take up to 5 s); "no report" past 15 s; the tooltip always has the age.
  - A cell's label goes by the last 10 seconds, not the latest request, so a target failing on and off reads "failing" and does not flicker to "ok". The count beside it is for the same minute as the graph; the since-start total is in the tooltip.
  - The log gets the verdict changes ("Inside: degraded", "Inside: outage", with all reasons seen while it lasted), per-pod failed requests for the Service and API server targets, and endpoint changes. Only what happened after the page started measuring is logged. An inside outage flashes and beeps like an outside one.

**Code layout**
- Pure logic lives in `web/static/lib/*.mjs` and is unit-tested with `node --test web/test/`: classification, the outage/degraded tracker, result reordering, the latency histogram, the per-second series, formatting, and session save/restore.
- `app.js` (probing, tiles, log, controls, storage) and `timeline.js` (uPlot chart and node strip) hold everything that touches the DOM.
- uPlot 1.6.32 is vendored unmodified in `web/static/vendor/uplot/` with its licence, and loaded as a global script.

**Outage logic**
- Probes are sent on a fixed schedule and overlap while a target hangs, so results arrive out of order. They are fed to the state machine in **send order**; a result waits until all earlier ones are in, at most one timeout.
- An outage runs from the send time of the first failed request to the send time of the first request answered again: accurate to one probe interval. An outage of timeouts shows up one timeout late, with its true start.
- "Degraded" is only judged once the pod window holds at least 8 answers per expected replica, so a pod missing by chance is not reported; with fewer the UI says degraded detection is off. After an outage the pods are judged afresh.
- An outage starts after `failThreshold` consecutive failures (default 3) and ends on the first success.
- **Failed requests are logged per episode, not per failure.** An episode starts with the first failed request and ends once 10 seconds pass without another; while it runs its log line shows the count so far, and when it ends the line carries the time span. This keeps a target that fails on and off (one dead backend out of three) to one line. The browser groups its own blips (`web/static/lib/episodes.mjs`); each pod groups all failures of an internal target into a "failing" incident (`internal/probe/target.go`). Keep the two in step.
- **Failing first, then outage.** Fewer failures in a row than `failThreshold` are a "blip": the tile is amber "failing", the failures are counted, and the log records them as "Failed requests", not as an outage. Only outages flash and beep. Both state machines (JS and Go) emit the blip.

**What counts as an outage (decided with the user, do not loosen or tighten without asking)**
- **Outside:** an external target (route, gateway) is in outage when `failThreshold` requests in a row fail from the browser.
- **Inside:** judged over all pods together, never from one pod's view:
  - *ok*: every expected pod reports, they all reach each other, and the Service answers for all of them;
  - *degraded*: something is missing (a pod or node away, a pod the others cannot reach, fewer pods answering than expected) but requests are answered. One pod left is degraded, not an outage;
  - *failing*: the Service answers, but some requests to it fail: at least 3 failed requests in the last 10 seconds from some pod's view. This is the time after a node dies while the Service still sends requests to its pod. It ranks above degraded and below outage, and does not flash;
  - *outage*: no reporting pod gets an answer from the Service;
  - *unknown*: no report arrives (typically because the outside is down).
- One pod's failed requests to the Service or the API server are logged as "Inside: failed requests" and never change the verdict. In the table a cell says "no answer" or "unreachable", not "outage".
- The API server probe goes through the load-balanced `kubernetes` Service and cannot tell which control-plane node a request went to; it does not affect the verdict. Probing each API server instance was considered and declined (it needs RBAC in the `default` namespace).
- "Degraded" means requests succeed but fewer distinct pods answered in the last `podWindowSec` than `expectedReplicas`. This is the "replicas=3 keeps us up" story.

**UI**
- One tile per target, external and internal.
  - States: green, amber (degraded/slow), red (outage).
  - Shows current latency and a running outage timer.
- Outage start: red flash, plus a beep via the Web Audio API.
  - Sound needs a user gesture, so add a "🔊 enable sound" toggle.
  - The flash has its own switch, on by default and remembered in the browser.
- Every section of the page folds with `<details>`/`<summary>`, like "How to read this", and stays the way the viewer left it. A folded section still shows its state in its heading (target states, the inside verdict, the number of log entries).
- Accumulated counters per target:
  - requests, failures, outages, longest outage, total downtime
  - availability %, p50/p99 latency
- Latency timeline (uPlot) with outage bands, and a pod/node strip showing who answered over time.
  - The timeline holds the slowest answer per second for the last 6 hours, in memory only; it is not saved and is lost on reload.
  - The strip has one lane per node for each target, plus a "failed" lane. Lanes are per node, not per pod, because pod names change on every rollout; new pods are announced in the log.
  - Colours: the series colours identify targets and were checked for colour-blind separation; green, amber and red are reserved for state.
- **Event markers:** a button plus a text field ("MCP rollout start", "node2 power off") that draws a vertical line on the timeline and appears in the log.
- Outage/event log table; export as CSV and JSON.
- Save counters and log to `localStorage` periodically so an accidental reload doesn't lose everything. Add a reset button.
- If `document.visibilityState` becomes hidden, show a warning banner and record a "measurement gap", since browsers throttle timers in background tabs.
  - Timers that stall while the tab is visible (sleep, overloaded browser) and page reloads are logged as measurement gaps too.
- Show which origin the SPA itself was loaded from.
- A small footer with the legal notice: version, copyright, AGPL with a link to `/LICENSE`, no warranty, and a "Source code" link. Keep it small, but never remove it (see Licence).

## Config (ConfigMap `glitchmonitor-config`, YAML; env vars override)
Env overrides are named `GLITCHMONITOR_<SECTION>_<KEY>`, e.g. `GLITCHMONITOR_SERVER_PORT`, `GLITCHMONITOR_SERVER_SHUTDOWN_DELAY`, `GLITCHMONITOR_BROWSER_INTERVAL_MS`. Never add `GLITCHMONITOR_PORT` or `GLITCHMONITOR_SERVICE_*`: Kubernetes sets those for the Service of the same name.
```yaml
external:
  - name: route
    url: https://glitchmonitor.apps.CLUSTER_DOMAIN
    enabled: true
  - name: gateway
    url: https://glitchmonitor.gtw.CLUSTER_DOMAIN
    enabled: true
corsAllowedOrigins:
  - https://glitchmonitor.apps.CLUSTER_DOMAIN
  - https://glitchmonitor.gtw.CLUSTER_DOMAIN
browser:
  intervalMs: 100
  timeoutMs: 2000
  slowMs: 500
  failThreshold: 3
  expectedReplicas: 3
  podWindowSec: 5
  retry: true
internal:
  intervalMs: 200
  timeoutMs: 1000
  slowMs: 200
  failThreshold: 3
  connectTimeoutMs: 500
  retry: true
  targets:
    service: { enabled: true, modes: [keepalive, fresh] }
    podDirect: { enabled: true, modes: [fresh] }
    apiserver: { enabled: true }
server:
  port: 8080
  shutdownDelay: 5s
```

## Deployment: kustomize and Helm, kept identical
There are two supported ways to deploy, and they must render the same objects:
- **kustomize:** `oc apply -k deploy/overlays/<name>` (`make deploy`). Needs nothing but `oc`.
- **Helm:** `helm upgrade --install glitchmonitor deploy/chart/glitchmonitor -n glitchmonitor --create-namespace -f deploy/values/<name>.yaml`, or through Argo CD (`deploy/argocd/application.yaml` is an example Application).

Rules:
- **Every manifest change is made in both** `deploy/base` / `deploy/components` and `deploy/chart/glitchmonitor/templates`. Every overlay `deploy/overlays/<name>` has a matching chart values file `deploy/values/<name>.yaml`.
- `make test` runs `deploy/consistency_test.go`, which renders every overlay it finds and the chart with the matching values file, and fails on any difference. It needs `helm` and `oc` (or `kubectl`/`kustomize`) and fails when they are missing; plain `go test ./...` skips it instead.
- Accepted differences, normalised by the test: the Namespace object (kustomize creates it, Helm installs into one), Helm's ownership labels, and how a config change rolls the pods (hashed ConfigMap name in kustomize, `checksum/config` pod annotation in Helm).
- Do not make kustomize depend on Helm (no `helmCharts` inflation): `oc apply -k` must keep working without it.
- One install per namespace is managed by one tool. To switch, delete the install first; Helm will not adopt objects created by `oc apply -k`.
- The chart does not own the namespace. A namespace label the Gateway requires is set by the kustomize overlay, by Argo CD `managedNamespaceMetadata`, or by hand for `helm install`.
- Object names are fixed (`glitchmonitor`, `glitchmonitor-peers`), not derived from the release name, because the internal probes address the Services by name.
- The image tag lives in the Makefile `VERSION`, the chart `version`/`appVersion` and the overlays' `images:`; the test checks they agree. Pull policy is `IfNotPresent`, so bump the version on every image change.

### Only the example is committed
- The repository holds only `example` settings: `deploy/overlays/example`, `deploy/values/example.yaml`, `example.com` hostnames, `registry.example.com`.
- Settings for a real cluster stay local and are git-ignored: further directories under `deploy/overlays/`, further files under `deploy/values/`, and `local.mk` (included by the Makefile; sets `REGISTRY`, `OVERLAY`, ...).
- **Never write a real cluster name, domain, registry, IP address, account or customer name into any committed file**, including this brief, comments, tests, docs and commit messages. Use `example` / `example.com`.

### Kustomize layout
- `deploy/base`:
  - Namespace `glitchmonitor`, ServiceAccount, Role/RoleBinding (EndpointSlices get/list/watch), ConfigMap.
  - Deployment:
    - 3 replicas, required pod anti-affinity on `kubernetes.io/hostname`.
    - Rolling update with `maxSurge: 0`, `maxUnavailable: 1`: with one pod per node a surge pod could never be scheduled.
    - `enableServiceLinks: false`.
    - Readiness and liveness probes, Downward API env vars.
    - `terminationGracePeriodSeconds: 30`.
    - Restricted SCC-compatible: non-root, no added capabilities.
  - Service `glitchmonitor` (ClusterIP) and headless `glitchmonitor-peers` with `publishNotReadyAddresses: true`.
  - PodDisruptionBudget `minAvailable: 2`.
    - In a 3-node cluster, an evicted pod stays Pending because of the anti-affinity. The PDB then blocks a second drain until the first node is back. That is correct and part of the demo.
- `deploy/components/route`: Route, edge TLS.
- `deploy/components/httproute`: HTTPRoute attached to the existing Gateway. Gateway name and namespace are parameters.
- `deploy/overlays/example`: enables either or both components, sets the cluster domain.

### Helm layout
- `deploy/chart/glitchmonitor`: the chart. Values: image, `clusterDomain`, `route.enabled`, `httproute.enabled` with Gateway name and namespace, replicas, PDB, resources, and `config` passed through to the app. Enabled ways in become the app's external targets and CORS origins.
- `deploy/values/<name>.yaml`: values matching `deploy/overlays/<name>`.
- `deploy/argocd/application.yaml`: example Argo CD Application installing the chart.

## Build
- Go (current stable), `CGO_ENABLED=0`, single static binary.
- Containerfile: multi-stage, final image UBI-micro or distroless, runs as non-root.
- `Makefile` targets: `build`, `test`, `image`, `push` (registry configurable), `deploy` (`oc apply -k`).
- `make test` also runs `helm lint` and the kustomize/Helm consistency check.
- Unit tests for: outage/degraded state machine (Go side and JS side), classification, config loading, CORS.

## Milestones
1. **M1:** server with `/api/ping`, `/healthz`, `/readyz`, graceful shutdown, config loading, CORS; SPA with one live tile per external target; base manifests plus Route/HTTPRoute components. Deployable end to end.
2. **M2:** browser outage/degraded logic, counters, flash and beep, timeline, pod/node strip, event markers, log, export, localStorage, visibility warning.
3. **M3:** internal probes (Service keepalive/fresh, pod-direct, EndpointSlice tagging, apiserver), `/api/internal`, merged internal tiles in the UI.
4. **M4:** README with the demo script below, plus tuning notes.
5. **Later:** headless `glitchmonitor probe` mode writing NDJSON, and a small report generator.

### To do, not yet scheduled
Ideas agreed as worth doing; decide per item whether it joins M4 or comes later.
- **Custom time range for the timeline:** any span from 30 seconds to 6 hours, beside the fixed 5 min / 30 min / 3 h / 6 h buttons. Beyond 6 hours can come later, since the timeline only keeps 6 hours.
- **Open a previous run:** load a JSON export and show how that run went, as a read-only view of the dashboard. Today's export holds the log, the counters and the config but not the per-second data behind the timeline and the "Who answered" strip, so the export has to carry that too before a past run can be shown in full.
- **Keep listening after a browser timeout:** count the request as timed out as now, but let it run on for up to 30 seconds and record what eventually came back (status and time), to see what the route or gateway would have answered. Proposed, not yet decided.

## Demo script (for README)
1. **Baseline:** 5 minutes idle, everything green.
2. **Rolling restart:** `oc rollout restart deploy/glitchmonitor`. Compare `shutdownDelay` 0s with 5s.
3. **Drain one node:** `oc adm drain <node> --ignore-daemonsets --delete-emptydir-data`. Watch the pod go Pending and traffic shift to 2 pods. Then `oc adm uncordon`.
4. **MCP rollout:** apply a harmless MachineConfig (e.g. a file under `/etc`) and watch nodes reboot one at a time.
5. **OCP minor upgrade:** run unattended, ideally with headless mode as well.
6. **Hard node failure:** power off a node via BMC/iLO. Expect:
   - an ingress VIP failover gap
   - tens of seconds of partial errors until the node is NotReady and its endpoints are pulled
   - the pod-direct tiles showing the difference between Service and pod

## Open questions to ask the user before or during M1
- Exact cluster domain, and Gateway name/namespace for the HTTPRoute.
- Container registry to push to; whether the cluster is disconnected, which needs image mirroring.
- TLS on the `gtw` hostname: is the certificate trusted by demo browsers? An untrusted cert makes `fetch()` fail silently. Workaround: open the URL once and accept the cert.
- Namespace name if `glitchmonitor` isn't acceptable.

## Licence
- AGPL-3.0-or-later (`LICENSE`), with commercial licences from the Stewards (`COMMERCIAL-LICENSING.md`) and a CLA for contributions (`CLA.md`, `CONTRIBUTING.md`).
- **Every source file starts with `SPDX-License-Identifier: AGPL-3.0-or-later`** as a comment: Go, JS, CSS, HTML (after the doctype), YAML manifests, the Makefile and the Containerfile. In Go, leave a blank line after it. No copyright line per file.
- Vendored third-party files (e.g. uPlot) keep their own licence header and are not relicensed; dependencies must be AGPL-compatible. **Every third-party component is listed in `THIRD-PARTY-NOTICES.md` with its licence file in the repository:** Go modules under `third_party/licenses/<module path with dashes>/`, vendored frontend code next to it in `web/static/vendor/<name>/LICENSE`, and the Go runtime's in `third_party/licenses/go/`. `make test` fails when a module in `go.mod` or a directory under `web/static/vendor` is missing from the notices or has no licence file. The app serves the notices and all licence texts at `/THIRD-PARTY-NOTICES` (linked from the footer), and the image carries them under `/licenses`.
- **The running app offers its licence and source (AGPL sections 5 and 13):** the dashboard footer shows the copyright, the licence with a link to `/LICENSE` (embedded in the binary), a no-warranty note and a link to the source. The source URL is built in with `-X main.sourceURL` (`SOURCE_URL` in the Makefile); whoever runs a modified build must point it at their own source.
- **Commit messages end with `Assisted-by: Claude (Anthropic)`, never `Co-Authored-By:`** for an AI tool: a tool is not an author and cannot agree to the CLA (see "AI-assisted contributions" in `CONTRIBUTING.md`).
- The README (M4) gets a "Licence" section pointing at these files.

## Non-goals
- No authentication; this is a demo app. Keep it internal.
- No server-side persistence or Prometheus. Optional `/metrics` later.
