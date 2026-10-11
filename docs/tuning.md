# Tuning

The defaults suit a first test. These are the settings worth knowing.

| Setting | Default | What it does |
|---|---|---|
| `server.shutdownDelay` | `5s` | After the pod is told to stop, it reports not ready and keeps answering this long, so routers and the Service can stop sending it traffic first. Set it to `0s` to see the lost requests it prevents. |
| `browser.intervalMs` | `100` | Time between requests from the page, per address. It is also how precisely an outage is timed. |
| `browser.timeoutMs` | `2000` | When the page gives up on a request. An outage made of timeouts appears this much later, with its true start time. |
| `browser.failThreshold` | `3` | Failed requests in a row that make an outage. Fewer are logged as "failed requests": a glitch, not an outage. Set it to `1` for the strictest reading. |
| `browser.expectedReplicas` | `3` | How many pods should be answering. Fewer within `podWindowSec` shows as "degraded". |
| `internal.connectTimeoutMs` | `500` | How long an inside probe waits for a connection to open. It is what turns a dead node into a quick `timeout_connect`. |
| `internal.retry`, `browser.retry` | `true` | Send a failed request once more and record whether that worked. |

Three things outside this app decide most of what you will measure:

- **How fast the cluster marks a silent node as lost.** Nothing on that node is taken out of rotation before then.
- **Where the ingress pods run.** Two replicas on the same node are one failure away from none.
- **Whether there is room to fail over.** A replacement pod needs unreserved CPU on another node. On our cluster one log collector had reserved three cores per node and used a tenth of one.

The configuration is a ConfigMap; `deploy/base/config.yaml` lists every key. Environment variables named `GLITCHMONITOR_<SECTION>_<KEY>` override it.
