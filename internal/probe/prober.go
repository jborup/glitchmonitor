// SPDX-License-Identifier: AGPL-3.0-or-later

package probe

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"sync/atomic"
	"time"
)

// Spec says how to probe one target.
type Spec struct {
	URL      string
	Interval time.Duration
	Timeout  time.Duration // for the whole request
	// ConnectTimeout bounds opening the connection, TLS included. Zero leaves
	// it to Timeout.
	ConnectTimeout time.Duration
	Slow           time.Duration
	// Retry tries a failed request once more, on a new connection. The first
	// attempt stays the result; the retry is recorded beside it.
	Retry bool
	// Fresh opens a new connection (TCP, and TLS if any) for every request.
	// Otherwise all requests share one kept-alive connection.
	Fresh bool
	TLS   *tls.Config
	// Header may add headers to each request, such as a bearer token.
	Header func(*http.Request)
	// Parse checks a 2xx body and extracts who answered. Nil accepts any body.
	Parse func(body []byte) (pod, node string, ok bool)
	// Annotate may tag a result when its probe is sent.
	Annotate func(*Result)
}

// ParsePing reads the body of /api/ping.
func ParsePing(body []byte) (pod, node string, ok bool) {
	var p struct {
		Pod  string `json:"pod"`
		Node string `json:"node"`
	}
	if err := json.Unmarshal(body, &p); err != nil || p.Pod == "" {
		return "", "", false
	}
	return p.Pod, p.Node, true
}

// newClient builds the HTTP client for a target. A fresh client opens a new
// connection for every request; otherwise all requests share one.
func newClient(spec Spec, fresh bool) (*http.Client, *http.Transport) {
	transport := &http.Transport{
		// No proxy: these targets are inside the cluster.
		Proxy:               nil,
		DialContext:         (&net.Dialer{Timeout: spec.ConnectTimeout}).DialContext,
		TLSHandshakeTimeout: spec.ConnectTimeout,
		TLSClientConfig:     spec.TLS,
		DisableKeepAlives:   fresh,
	}
	if !fresh {
		// One connection, so this really measures "the connection I already have".
		transport.MaxConnsPerHost = 1
		transport.MaxIdleConnsPerHost = 1
	}
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return client, transport
}

// Run probes until ctx is cancelled. Probes are sent on a fixed schedule, not
// "interval after the previous answer", so a hanging request does not slow the
// probe rate down; results reach the target in send order.
func Run(ctx context.Context, spec Spec, target *Target) {
	client, transport := newClient(spec, spec.Fresh)
	defer transport.CloseIdleConnections()
	// A retry always goes out on a new connection, as a careful client's would.
	retryClient := client
	if spec.Retry && !spec.Fresh {
		var retryTransport *http.Transport
		retryClient, retryTransport = newClient(spec, true)
		defer retryTransport.CloseIdleConnections()
	}

	order := NewReorder(target.Apply)
	ticker := time.NewTicker(spec.Interval)
	defer ticker.Stop()
	var seq uint64
	for {
		seq++
		go func(seq uint64) {
			r := once(ctx, client, spec)
			if spec.Retry && r.Class.Failure() && ctx.Err() == nil {
				again := once(ctx, retryClient, spec)
				r.Retry = &Attempt{Class: again.Class, Status: again.Status, Latency: again.Latency}
			}
			if ctx.Err() == nil {
				order.Push(seq, r)
			}
		}(seq)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// once makes one request and classifies what came of it.
func once(ctx context.Context, client *http.Client, spec Spec) Result {
	r := Result{T: time.Now()}
	if spec.Annotate != nil {
		spec.Annotate(&r)
	}
	ctx, cancel := context.WithTimeout(ctx, spec.Timeout)
	defer cancel()
	// Whether the request went out decides between "could not connect" and
	// "sent, but no answer", and with it whether a retry is safe.
	var sent atomic.Bool
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		WroteRequest: func(httptrace.WroteRequestInfo) { sent.Store(true) },
	})

	var body []byte
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, spec.URL, nil)
	if err == nil {
		if spec.Header != nil {
			spec.Header(req)
		}
		var resp *http.Response
		if resp, err = client.Do(req); err == nil {
			r.Status = resp.StatusCode
			body, err = io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			resp.Body.Close()
		}
	}
	latency := time.Since(r.T)
	r.Sent = sent.Load()

	var pod, node string
	badBody := false
	if err == nil && r.Status >= 200 && r.Status <= 299 && spec.Parse != nil {
		var ok bool
		pod, node, ok = spec.Parse(body)
		badBody = !ok
	}
	r.Class = Classify(r.Status, badBody, latency, spec.Slow, r.Sent, err)
	if !r.Class.Failure() {
		r.Pod, r.Node = pod, node
	}
	// A failure has no latency worth plotting, but a retry's total time matters.
	r.Latency = latency
	return r
}
