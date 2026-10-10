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
  | `GET /api/ping` | `{pod, node, podIP, serverTime, seq}`; `Cache-Control: no-store`; CORS per config |
  | `GET /api/internal` | This pod's internal probe results: ring buffer of last ~10 min plus counters per target; CORS per config |
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
- **Result classes:** `ok`, `slow` (over threshold), `http_5xx`, `http_other`, `timeout`, `conn_refused`, `dns_error`, `tls_error`, `other_error`. Each result records timestamp, latency, and which pod/node answered.
- Default interval is 200 ms per target, configurable.

### Browser (SPA)

**Probing**
- For each enabled external target from `/api/config`, `fetch()` `/api/ping` at the configured interval (default 100 ms).
- Use `AbortController` for timeouts, `cache: 'no-store'`, `mode: 'cors'`, and `performance.now()` for timing.
- Classify each result as `ok`, `slow`, `http_5xx`, `http_other`, `timeout`, or `network_error`. The browser can't tell DNS, TLS and connection-refused apart; say so in the UI help text.
- Pull `/api/internal` every 1–2 s through whichever external target is currently up, and merge the results per reporting pod.
  - If a pod's report stops updating, mark it stale. That is expected when its node dies; show it, don't hide it.

**Outage logic**
- An outage starts after `failThreshold` consecutive failures (default 1) and ends on the first success.
- "Degraded" means requests succeed but fewer distinct pods answered in the last `podWindowSec` than `expectedReplicas`. This is the "replicas=3 keeps us up" story.

**UI**
- One tile per target, external and internal.
  - States: green, amber (degraded/slow), red (outage).
  - Shows current latency and a running outage timer.
- Outage start: red flash, plus a beep via the Web Audio API.
  - Sound needs a user gesture, so add a "🔊 enable sound" toggle.
- Accumulated counters per target:
  - requests, failures, outages, longest outage, total downtime
  - availability %, p50/p99 latency
- Latency timeline (uPlot) with outage bands, and a pod/node strip showing who answered over time.
- **Event markers:** a button plus a text field ("MCP rollout start", "node2 power off") that draws a vertical line on the timeline and appears in the log.
- Outage/event log table; export as CSV and JSON.
- Save counters and log to `localStorage` periodically so an accidental reload doesn't lose everything. Add a reset button.
- If `document.visibilityState` becomes hidden, show a warning banner and record a "measurement gap", since browsers throttle timers in background tabs.
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
  failThreshold: 1
  expectedReplicas: 3
  podWindowSec: 5
internal:
  intervalMs: 200
  timeoutMs: 1000
  slowMs: 200
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
- Vendored third-party files (e.g. uPlot) keep their own licence header and are not relicensed; dependencies must be AGPL-compatible. The image carries the licence texts under `/licenses`, third-party ones under `/licenses/third_party`; add each new dependency's there in the Containerfile.
- **The running app offers its licence and source (AGPL sections 5 and 13):** the dashboard footer shows the copyright, the licence with a link to `/LICENSE` (embedded in the binary), a no-warranty note and a link to the source. The source URL is built in with `-X main.sourceURL` (`SOURCE_URL` in the Makefile); whoever runs a modified build must point it at their own source.
- **Commit messages end with `Assisted-by: Claude (Anthropic)`, never `Co-Authored-By:`** for an AI tool: a tool is not an author and cannot agree to the CLA (see "AI-assisted contributions" in `CONTRIBUTING.md`).
- The README (M4) gets a "Licence" section pointing at these files.

## Non-goals
- No authentication; this is a demo app. Keep it internal.
- No server-side persistence or Prometheus. Optional `/metrics` later.
