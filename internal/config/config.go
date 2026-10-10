// SPDX-License-Identifier: AGPL-3.0-or-later

// Package config loads the glitchmonitor configuration: built-in defaults,
// overlaid by an optional YAML file, overlaid by environment variables.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// EnvPrefix is prepended to every environment variable override.
const EnvPrefix = "GLITCHMONITOR_"

// Duration is a time.Duration written as a Go duration string ("5s") in YAML and JSON.
type Duration time.Duration

func (d *Duration) UnmarshalYAML(n *yaml.Node) error {
	var s string
	if err := n.Decode(&s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("line %d: %w", n.Line, err)
	}
	*d = Duration(v)
	return nil
}

func (d Duration) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Quote(time.Duration(d).String())), nil
}

type External struct {
	Name    string `yaml:"name" json:"name"`
	URL     string `yaml:"url" json:"url"`
	Enabled bool   `yaml:"enabled" json:"enabled"`
}

type Browser struct {
	IntervalMs       int `yaml:"intervalMs" json:"intervalMs"`
	TimeoutMs        int `yaml:"timeoutMs" json:"timeoutMs"`
	SlowMs           int `yaml:"slowMs" json:"slowMs"`
	FailThreshold    int `yaml:"failThreshold" json:"failThreshold"`
	ExpectedReplicas int `yaml:"expectedReplicas" json:"expectedReplicas"`
	PodWindowSec     int `yaml:"podWindowSec" json:"podWindowSec"`
	// Retry makes the browser send a failed request once more, to show what a
	// web application that retries would get. The first attempt is what counts.
	Retry bool `yaml:"retry" json:"retry"`
}

type InternalTarget struct {
	Enabled bool     `yaml:"enabled" json:"enabled"`
	Modes   []string `yaml:"modes,omitempty" json:"modes,omitempty"`
}

type InternalTargets struct {
	Service   InternalTarget `yaml:"service" json:"service"`
	PodDirect InternalTarget `yaml:"podDirect" json:"podDirect"`
	APIServer InternalTarget `yaml:"apiserver" json:"apiserver"`
}

type Internal struct {
	IntervalMs    int `yaml:"intervalMs" json:"intervalMs"`
	TimeoutMs     int `yaml:"timeoutMs" json:"timeoutMs"`
	SlowMs        int `yaml:"slowMs" json:"slowMs"`
	FailThreshold int `yaml:"failThreshold" json:"failThreshold"`
	// ConnectTimeoutMs bounds opening the connection; TimeoutMs bounds the whole request.
	ConnectTimeoutMs int `yaml:"connectTimeoutMs" json:"connectTimeoutMs"`
	// Retry makes a failed probe try once more on a new connection, to show
	// what a client that retries would get. The first attempt is what counts.
	Retry   bool            `yaml:"retry" json:"retry"`
	Targets InternalTargets `yaml:"targets" json:"targets"`
}

type Server struct {
	Port          int      `yaml:"port" json:"port"`
	ShutdownDelay Duration `yaml:"shutdownDelay" json:"shutdownDelay"`
}

type Config struct {
	External           []External `yaml:"external" json:"external"`
	CORSAllowedOrigins []string   `yaml:"corsAllowedOrigins" json:"corsAllowedOrigins"`
	Browser            Browser    `yaml:"browser" json:"browser"`
	Internal           Internal   `yaml:"internal" json:"internal"`
	Server             Server     `yaml:"server" json:"server"`
}

// Default returns the configuration used for every key the file and environment leave unset.
func Default() *Config {
	return &Config{
		Browser: Browser{
			IntervalMs:       100,
			TimeoutMs:        2000,
			SlowMs:           500,
			FailThreshold:    3,
			ExpectedReplicas: 3,
			PodWindowSec:     5,
			Retry:            true,
		},
		Internal: Internal{
			IntervalMs:       200,
			TimeoutMs:        1000,
			SlowMs:           200,
			FailThreshold:    3,
			ConnectTimeoutMs: 500,
			Retry:            true,
			Targets: InternalTargets{
				Service:   InternalTarget{Enabled: true, Modes: []string{"keepalive", "fresh"}},
				PodDirect: InternalTarget{Enabled: true, Modes: []string{"fresh"}},
				APIServer: InternalTarget{Enabled: true},
			},
		},
		Server: Server{Port: 8080, ShutdownDelay: Duration(5 * time.Second)},
	}
}

// Load builds the configuration. An empty path means "no file". getenv is
// os.Getenv in production and a map lookup in tests.
func Load(path string, getenv func(string) string) (*Config, error) {
	cfg := Default()
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if err := Parse(data, cfg); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	}
	if err := applyEnv(cfg, getenv); err != nil {
		return nil, err
	}
	if err := cfg.normalize(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Parse decodes YAML over cfg, leaving keys the document does not mention untouched.
// Unknown keys are an error, so a typo does not silently fall back to a default.
func Parse(data []byte, cfg *Config) error {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(cfg); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func applyEnv(cfg *Config, getenv func(string) string) error {
	var errs []error
	get := func(key string) (string, bool) {
		v := getenv(EnvPrefix + key)
		return v, v != ""
	}
	setInt := func(key string, dst *int) {
		if v, ok := get(key); ok {
			n, err := strconv.Atoi(v)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s%s: %q is not an integer", EnvPrefix, key, v))
				return
			}
			*dst = n
		}
	}
	setBool := func(key string, dst *bool) {
		if v, ok := get(key); ok {
			b, err := strconv.ParseBool(v)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s%s: %q is not a boolean", EnvPrefix, key, v))
				return
			}
			*dst = b
		}
	}

	// Not PORT: Kubernetes injects GLITCHMONITOR_PORT=tcp://... for the Service of the same name.
	setInt("SERVER_PORT", &cfg.Server.Port)
	if v, ok := get("SERVER_SHUTDOWN_DELAY"); ok {
		d, err := time.ParseDuration(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("%sSERVER_SHUTDOWN_DELAY: %w", EnvPrefix, err))
		} else {
			cfg.Server.ShutdownDelay = Duration(d)
		}
	}
	if v, ok := get("CORS_ALLOWED_ORIGINS"); ok {
		cfg.CORSAllowedOrigins = nil
		for _, o := range strings.Split(v, ",") {
			if o = strings.TrimSpace(o); o != "" {
				cfg.CORSAllowedOrigins = append(cfg.CORSAllowedOrigins, o)
			}
		}
	}
	for i := range cfg.External {
		e := &cfg.External[i]
		key := "EXTERNAL_" + envName(e.Name)
		if v, ok := get(key + "_URL"); ok {
			e.URL = v
		}
		setBool(key+"_ENABLED", &e.Enabled)
	}
	setInt("BROWSER_INTERVAL_MS", &cfg.Browser.IntervalMs)
	setInt("BROWSER_TIMEOUT_MS", &cfg.Browser.TimeoutMs)
	setInt("BROWSER_SLOW_MS", &cfg.Browser.SlowMs)
	setInt("BROWSER_FAIL_THRESHOLD", &cfg.Browser.FailThreshold)
	setInt("BROWSER_EXPECTED_REPLICAS", &cfg.Browser.ExpectedReplicas)
	setInt("BROWSER_POD_WINDOW_SEC", &cfg.Browser.PodWindowSec)
	setBool("BROWSER_RETRY", &cfg.Browser.Retry)
	setInt("INTERNAL_INTERVAL_MS", &cfg.Internal.IntervalMs)
	setInt("INTERNAL_TIMEOUT_MS", &cfg.Internal.TimeoutMs)
	setInt("INTERNAL_SLOW_MS", &cfg.Internal.SlowMs)
	setInt("INTERNAL_FAIL_THRESHOLD", &cfg.Internal.FailThreshold)
	setInt("INTERNAL_CONNECT_TIMEOUT_MS", &cfg.Internal.ConnectTimeoutMs)
	setBool("INTERNAL_RETRY", &cfg.Internal.Retry)
	return errors.Join(errs...)
}

// envName turns a target name into its environment variable form: "my-gw" -> "MY_GW".
func envName(name string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r - 'a' + 'A'
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		}
		return '_'
	}, name)
}

func (c *Config) normalize() error {
	var errs []error
	bad := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }

	seen := map[string]bool{}
	for i := range c.External {
		e := &c.External[i]
		if e.Name == "" {
			bad("external[%d]: name is required", i)
		} else if seen[e.Name] {
			bad("external[%d]: duplicate name %q", i, e.Name)
		}
		seen[e.Name] = true
		o, err := origin(e.URL)
		if err != nil {
			bad("external[%d] (%s): url: %w", i, e.Name, err)
		}
		e.URL = o
	}
	for i, o := range c.CORSAllowedOrigins {
		if o == "*" {
			continue
		}
		n, err := origin(o)
		if err != nil {
			bad("corsAllowedOrigins[%d]: %w", i, err)
		}
		c.CORSAllowedOrigins[i] = n
	}

	positive := map[string]int{
		"browser.intervalMs":        c.Browser.IntervalMs,
		"browser.timeoutMs":         c.Browser.TimeoutMs,
		"browser.slowMs":            c.Browser.SlowMs,
		"browser.failThreshold":     c.Browser.FailThreshold,
		"browser.expectedReplicas":  c.Browser.ExpectedReplicas,
		"browser.podWindowSec":      c.Browser.PodWindowSec,
		"internal.intervalMs":       c.Internal.IntervalMs,
		"internal.timeoutMs":        c.Internal.TimeoutMs,
		"internal.slowMs":           c.Internal.SlowMs,
		"internal.failThreshold":    c.Internal.FailThreshold,
		"internal.connectTimeoutMs": c.Internal.ConnectTimeoutMs,
	}
	for name, v := range positive {
		if v <= 0 {
			bad("%s must be greater than 0, got %d", name, v)
		}
	}
	for name, t := range map[string]InternalTarget{
		"service":   c.Internal.Targets.Service,
		"podDirect": c.Internal.Targets.PodDirect,
	} {
		for _, m := range t.Modes {
			if m != "keepalive" && m != "fresh" {
				bad("internal.targets.%s.modes: unknown mode %q (want keepalive or fresh)", name, m)
			}
		}
	}
	if c.Internal.ConnectTimeoutMs > c.Internal.TimeoutMs {
		bad("internal.connectTimeoutMs (%d) must not be greater than internal.timeoutMs (%d)", c.Internal.ConnectTimeoutMs, c.Internal.TimeoutMs)
	}
	if c.Server.Port < 1 || c.Server.Port > 65535 {
		bad("server.port %d is out of range", c.Server.Port)
	}
	if c.Server.ShutdownDelay < 0 {
		bad("server.shutdownDelay must not be negative")
	}
	return errors.Join(errs...)
}

// origin validates an http(s) URL and reduces it to scheme://host[:port], the
// form a browser sends in the Origin header.
func origin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return raw, err
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return raw, fmt.Errorf("%q is not an http(s) URL", raw)
	}
	if u.Path != "" && u.Path != "/" {
		return raw, fmt.Errorf("%q must not have a path", raw)
	}
	return u.Scheme + "://" + u.Host, nil
}
