// SPDX-License-Identifier: AGPL-3.0-or-later

// Package probe is the probing logic shared by the in-cluster internal probes
// and, later, the headless probe mode: classification of one result, the
// outage and degraded state machine, and the loop that probes one target.
package probe

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"strings"
	"syscall"
	"time"
)

// Class is the outcome of one probe.
type Class string

const (
	OK        Class = "ok"
	Slow      Class = "slow" // answered, but over the slow threshold
	HTTP5xx   Class = "http_5xx"
	HTTPOther Class = "http_other" // any other unexpected answer
	// Timeout is a timeout whose phase is not known, as a browser reports it.
	Timeout Class = "timeout"
	// TimeoutConnect: time ran out before the request was sent, typically
	// because the connection never opened. Nothing reached the server, so
	// trying again cannot do anything twice.
	TimeoutConnect Class = "timeout_connect"
	// TimeoutResponse: the request was sent and no answer came in time. The
	// client cannot know whether the server acted on it.
	TimeoutResponse Class = "timeout_response"
	ConnRefused     Class = "conn_refused"
	DNSError        Class = "dns_error"
	TLSError        Class = "tls_error"
	OtherError      Class = "other_error"
)

// Failure reports whether the class counts against availability. A slow
// answer is still an answer.
func (c Class) Failure() bool { return c != OK && c != Slow }

// Classify turns what one request returned into a Class. err is the error
// from the HTTP client, or nil when a response arrived; badBody means a 2xx
// response did not carry what the target should return; sent says whether the
// request had been written to the connection.
func Classify(status int, badBody bool, latency, slow time.Duration, sent bool, err error) Class {
	if err != nil {
		class := classifyError(err)
		if class == Timeout {
			if sent {
				return TimeoutResponse
			}
			return TimeoutConnect
		}
		return class
	}
	switch {
	case status >= 500 && status <= 599:
		return HTTP5xx
	case status < 200 || status > 299 || badBody:
		return HTTPOther
	case latency > slow:
		return Slow
	}
	return OK
}

func classifyError(err error) Class {
	// A DNS lookup that timed out is a DNS problem first.
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return DNSError
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return Timeout
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return ConnRefused
	}
	if isTLSError(err) {
		return TLSError
	}
	return OtherError
}

func isTLSError(err error) bool {
	var (
		verify    *tls.CertificateVerificationError
		authority x509.UnknownAuthorityError
		invalid   x509.CertificateInvalidError
		hostname  x509.HostnameError
		header    tls.RecordHeaderError
		alert     tls.AlertError
	)
	return errors.As(err, &verify) || errors.As(err, &authority) || errors.As(err, &invalid) ||
		errors.As(err, &hostname) || errors.As(err, &header) || errors.As(err, &alert) ||
		strings.Contains(err.Error(), "tls: ")
}
