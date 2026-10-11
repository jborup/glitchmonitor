# Deploying glitchmonitor

You need an OpenShift cluster with at least three schedulable nodes, a registry the cluster can pull from, and one or both of: the default router, and a Gateway with a listener for your hostname.

1. **Build and push the image.**
   ```sh
   make image push REGISTRY=registry.example.com
   ```
2. **Set your cluster's values.** Copy `deploy/overlays/example` and `deploy/values/example.yaml` under your cluster's name, and put in your domain, your registry, and your Gateway's name and namespace. Enable the Route, the HTTPRoute, or both.
3. **Deploy**, with kustomize or with Helm. The two render the same objects, and `make test` checks that.
   ```sh
   oc apply -k deploy/overlays/<name>
   ```
   ```sh
   helm upgrade --install glitchmonitor deploy/chart/glitchmonitor \
     -n glitchmonitor --create-namespace -f deploy/values/<name>.yaml
   ```
   For Argo CD there is an example Application in `deploy/argocd/application.yaml`.
4. **Open** `https://glitchmonitor.apps.<your domain>` and leave the tab visible.

If your Gateway only admits routes from labelled namespaces, label the namespace; the example overlay shows where. If a tile shows only `network_error` from the start, open that address in a new tab once: an untrusted certificate fails this way.

## Build and test

Go, with no build step for the frontend. `make test` runs the Go tests, the JavaScript tests (`node --test`), a Helm lint, and the check that the kustomize overlays and the Helm chart render the same objects; it needs `helm` and `oc`.

```sh
make build    # bin/glitchmonitor
make test
make image    # container image, amd64 by default
```
