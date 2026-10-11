# Running a test

Keep the dashboard in a visible window for the whole test, and add a marker at each step. A tab in the background is slowed down by the browser; the page logs that as a measurement gap.

1. **Baseline.** Five minutes idle. Everything should be green with no failures. If it is not, you have found something already.
2. **Rolling restart.** `oc rollout restart deploy/glitchmonitor -n glitchmonitor`. Then set `server.shutdownDelay` to `0s` and do it again, to see what the delay buys.
3. **Drain a node.** `oc adm drain <node> --ignore-daemonsets --delete-emptydir-data`. The evicted pod stays Pending and traffic moves to two pods; the tiles go "degraded", not red. Then `oc adm uncordon <node>`.
4. **Rolling update.** Apply a harmless MachineConfig, such as a one-line file under `/etc`, and watch the nodes reboot one at a time.
5. **Cluster upgrade.** Leave it running for the whole upgrade.
6. **Hard node failure.** Power a node off through its management interface. Do each node in turn: which one you lose matters more than you expect.

Afterwards, export the JSON. It is the record of the run, and it can be opened again and shown to someone who was not there.

**Know where things run before you start.** The result of a node failure depends on what that node held: a router pod, a gateway proxy, a control pod, the address itself. `oc get pods -n openshift-ingress -o wide` before each run turns a puzzling result into an explained one.
