# What a failed request means for a client

The inside probes record how each request failed, because the right reaction differs.

| How it failed | What happened | Is a retry safe? |
|---|---|---|
| `timeout_connect` | The connection never opened. A powered-off node answers nothing at all. | Yes. Nothing reached the server. |
| `conn_refused` | The node is up but nothing listens: the pod is gone. Fails at once. | Yes. Nothing reached the server. |
| `timeout_response` | The request was sent and no answer came. | Only if the request can be repeated. The client cannot know whether the server acted on it. |
| `http_503` and others | An answer came, with that status. | It depends on who sent it and why. |

Each pod also retries a failed request once, on a new connection, and the browser sends a failed request once more. The first attempt is what is counted; the retry is shown beside it. In our node tests a single retry rescued about two thirds of the failed requests inside the cluster, which fits one retry in three being sent to the dead pod again.

A browser cannot tell these apart. From outside, DNS failures, TLS failures and refused connections all appear as `network_error`, and every timeout as `timeout`.
