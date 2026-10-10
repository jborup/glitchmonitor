// SPDX-License-Identifier: AGPL-3.0-or-later

// Package kube holds the little this app needs from the Kubernetes API: the
// in-cluster credentials and a watch on the EndpointSlices of one Service.
// It talks plain HTTP to the API server instead of pulling in a client library.
package kube

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"
	listTimeout       = 5 * time.Second
	// The server ends a watch after watchSeconds; the client gives up a little
	// later, so a connection that died silently is noticed.
	watchSeconds = 30
	watchTimeout = 40 * time.Second
	retryDelay   = time.Second
	maxChanges   = 50
)

// InCluster is how a pod reaches the API server.
type InCluster struct {
	URL   string
	TLS   *tls.Config
	Token func() (string, error)
}

// LoadInCluster reads the ServiceAccount credentials mounted into the pod.
func LoadInCluster() (*InCluster, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT are not set")
	}
	ca, err := os.ReadFile(serviceAccountDir + "/ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("no certificates in the ServiceAccount ca.crt")
	}
	return &InCluster{
		URL: "https://" + net.JoinHostPort(host, port),
		TLS: &tls.Config{RootCAs: pool},
		// The token is rotated, so it is read again for every request.
		Token: func() (string, error) {
			token, err := os.ReadFile(serviceAccountDir + "/token")
			return strings.TrimSpace(string(token)), err
		},
	}, nil
}

// Change is one address becoming, or no longer being, a ready endpoint.
type Change struct {
	T     time.Time
	IP    string
	Ready bool
}

// Endpoints follows which pod IPs are ready endpoints of one Service, which is
// what decides whether the Service sends traffic to a pod.
type Endpoints struct {
	api       *InCluster
	client    *http.Client
	namespace string
	service   string
	log       *slog.Logger

	mu        sync.Mutex
	slices    map[string]map[string]bool // slice name -> address -> ready
	ready     map[string]bool            // merged over all slices
	synced    bool                       // listed at least once
	connected bool                       // the last list or watch worked
	changes   []Change
}

func NewEndpoints(api *InCluster, namespace, service string, log *slog.Logger) *Endpoints {
	return &Endpoints{
		api:       api,
		client:    &http.Client{Transport: &http.Transport{Proxy: nil, TLSClientConfig: api.TLS}},
		namespace: namespace,
		service:   service,
		log:       log,
		slices:    map[string]map[string]bool{},
		ready:     map[string]bool{},
	}
}

// Ready reports whether ip is a ready endpoint. known is false until the
// first list has succeeded.
func (e *Endpoints) Ready(ip string) (ready, known bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.ready[ip], e.synced
}

// Status reports whether the state was ever loaded, whether the connection to
// the API server currently works, and the most recent changes, oldest first.
func (e *Endpoints) Status() (synced, connected bool, changes []Change) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.synced, e.connected, append([]Change{}, e.changes...)
}

// Run lists and then watches until ctx is cancelled, starting over after any
// error. While the API server is unreachable the last known state is kept.
func (e *Endpoints) Run(ctx context.Context) {
	for ctx.Err() == nil {
		version, err := e.list(ctx)
		for err == nil {
			version, err = e.watch(ctx, version)
		}
		if ctx.Err() != nil {
			return
		}
		e.mu.Lock()
		wasConnected := e.connected
		e.connected = false
		e.mu.Unlock()
		if wasConnected {
			e.log.Warn("lost the EndpointSlice watch, retrying", "error", err.Error())
		}
		select {
		case <-ctx.Done():
		case <-time.After(retryDelay):
		}
	}
}

type endpointSlice struct {
	Metadata struct {
		Name            string `json:"name"`
		ResourceVersion string `json:"resourceVersion"`
	} `json:"metadata"`
	Endpoints []struct {
		Addresses  []string `json:"addresses"`
		Conditions struct {
			Ready *bool `json:"ready"`
		} `json:"conditions"`
	} `json:"endpoints"`
}

func (s *endpointSlice) addresses() map[string]bool {
	out := map[string]bool{}
	for _, ep := range s.Endpoints {
		// An unset condition means ready, as the API defines it.
		ready := ep.Conditions.Ready == nil || *ep.Conditions.Ready
		for _, a := range ep.Addresses {
			out[a] = out[a] || ready
		}
	}
	return out
}

func (e *Endpoints) get(ctx context.Context, query url.Values) (*http.Response, error) {
	query.Set("labelSelector", "kubernetes.io/service-name="+e.service)
	u := fmt.Sprintf("%s/apis/discovery.k8s.io/v1/namespaces/%s/endpointslices?%s", e.api.URL, e.namespace, query.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	token, err := e.api.Token()
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		return nil, fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return resp, nil
}

func (e *Endpoints) list(ctx context.Context) (version string, err error) {
	ctx, cancel := context.WithTimeout(ctx, listTimeout)
	defer cancel()
	resp, err := e.get(ctx, url.Values{})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var list struct {
		Metadata struct {
			ResourceVersion string `json:"resourceVersion"`
		} `json:"metadata"`
		Items []endpointSlice `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return "", err
	}
	slices := map[string]map[string]bool{}
	for i := range list.Items {
		slices[list.Items[i].Metadata.Name] = list.Items[i].addresses()
	}
	e.update(func() { e.slices = slices })
	return list.Metadata.ResourceVersion, nil
}

// watch applies changes until the server ends the watch, and returns the
// version to continue from.
func (e *Endpoints) watch(ctx context.Context, version string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, watchTimeout)
	defer cancel()
	resp, err := e.get(ctx, url.Values{
		"watch":               {"1"},
		"resourceVersion":     {version},
		"allowWatchBookmarks": {"true"},
		"timeoutSeconds":      {fmt.Sprint(watchSeconds)},
	})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	dec := json.NewDecoder(resp.Body)
	for {
		var ev struct {
			Type   string          `json:"type"`
			Object json.RawMessage `json:"object"`
		}
		if err := dec.Decode(&ev); errors.Is(err, io.EOF) {
			return version, nil
		} else if err != nil {
			return "", err
		}
		if ev.Type == "ERROR" {
			// Typically "410 Gone": the version is too old, so list again.
			return "", fmt.Errorf("watch error: %s", ev.Object)
		}
		var slice endpointSlice
		if err := json.Unmarshal(ev.Object, &slice); err != nil {
			return "", err
		}
		version = slice.Metadata.ResourceVersion
		switch ev.Type {
		case "ADDED", "MODIFIED":
			e.update(func() { e.slices[slice.Metadata.Name] = slice.addresses() })
		case "DELETED":
			e.update(func() { delete(e.slices, slice.Metadata.Name) })
		}
	}
}

// update applies a change to the slices and records which addresses became
// ready or stopped being ready. The very first load records nothing.
func (e *Endpoints) update(change func()) {
	e.mu.Lock()
	defer e.mu.Unlock()
	change()
	ready := map[string]bool{}
	for _, slice := range e.slices {
		for ip, r := range slice {
			if r {
				ready[ip] = true
			}
		}
	}
	if e.synced {
		now := time.Now()
		for ip := range ready {
			if !e.ready[ip] {
				e.changes = append(e.changes, Change{T: now, IP: ip, Ready: true})
			}
		}
		for ip := range e.ready {
			if !ready[ip] {
				e.changes = append(e.changes, Change{T: now, IP: ip, Ready: false})
			}
		}
		if len(e.changes) > maxChanges {
			e.changes = e.changes[len(e.changes)-maxChanges:]
		}
	}
	e.ready = ready
	e.synced, e.connected = true, true
}
