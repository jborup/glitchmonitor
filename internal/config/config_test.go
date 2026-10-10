// SPDX-License-Identifier: AGPL-3.0-or-later

package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// documented is the example from the project brief.
const documented = `
external:
  - name: route
    url: https://glitchmonitor.apps.example.com
    enabled: true
  - name: gateway
    url: https://glitchmonitor.gtw.example.com/
    enabled: false
corsAllowedOrigins:
  - https://glitchmonitor.apps.example.com
  - https://glitchmonitor.gtw.example.com/
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
`

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadWithoutFileUsesDefaults(t *testing.T) {
	cfg, err := Load("", env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg, Default()) {
		t.Errorf("got %+v, want defaults", cfg)
	}
}

func TestLoadDocumentedExample(t *testing.T) {
	cfg, err := Load(writeFile(t, documented), env(nil))
	if err != nil {
		t.Fatal(err)
	}
	want := []External{
		{Name: "route", URL: "https://glitchmonitor.apps.example.com", Enabled: true},
		{Name: "gateway", URL: "https://glitchmonitor.gtw.example.com", Enabled: false},
	}
	if !reflect.DeepEqual(cfg.External, want) {
		t.Errorf("external = %+v, want %+v", cfg.External, want)
	}
	wantOrigins := []string{"https://glitchmonitor.apps.example.com", "https://glitchmonitor.gtw.example.com"}
	if !reflect.DeepEqual(cfg.CORSAllowedOrigins, wantOrigins) {
		t.Errorf("corsAllowedOrigins = %v, want %v", cfg.CORSAllowedOrigins, wantOrigins)
	}
	if cfg.Browser != Default().Browser {
		t.Errorf("browser = %+v", cfg.Browser)
	}
	if !reflect.DeepEqual(cfg.Internal, Default().Internal) {
		t.Errorf("internal = %+v", cfg.Internal)
	}
	if cfg.Server.Port != 8080 || time.Duration(cfg.Server.ShutdownDelay) != 5*time.Second {
		t.Errorf("server = %+v", cfg.Server)
	}
}

func TestPartialFileKeepsDefaults(t *testing.T) {
	cfg, err := Load(writeFile(t, "browser:\n  intervalMs: 250\n"), env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Browser.IntervalMs != 250 {
		t.Errorf("intervalMs = %d, want 250", cfg.Browser.IntervalMs)
	}
	if cfg.Browser.TimeoutMs != 2000 || cfg.Server.Port != 8080 {
		t.Errorf("defaults lost: %+v %+v", cfg.Browser, cfg.Server)
	}
}

func TestEmptyFileUsesDefaults(t *testing.T) {
	cfg, err := Load(writeFile(t, ""), env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg, Default()) {
		t.Errorf("got %+v, want defaults", cfg)
	}
}

// A zero delay is how the demo shows the blips you get without graceful shutdown.
func TestZeroShutdownDelayIsAllowed(t *testing.T) {
	for name, load := range map[string]func() (*Config, error){
		"file": func() (*Config, error) {
			return Load(writeFile(t, "server:\n  shutdownDelay: 0s\n"), env(nil))
		},
		"env": func() (*Config, error) {
			return Load("", env(map[string]string{"GLITCHMONITOR_SERVER_SHUTDOWN_DELAY": "0s"}))
		},
	} {
		cfg, err := load()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if cfg.Server.ShutdownDelay != 0 {
			t.Errorf("%s: shutdownDelay = %v, want 0", name, time.Duration(cfg.Server.ShutdownDelay))
		}
	}
}

func TestEnvOverridesFile(t *testing.T) {
	cfg, err := Load(writeFile(t, documented), env(map[string]string{
		"GLITCHMONITOR_SERVER_PORT":              "9090",
		"GLITCHMONITOR_SERVER_SHUTDOWN_DELAY":    "1500ms",
		"GLITCHMONITOR_CORS_ALLOWED_ORIGINS":     "https://a.example.com, https://b.example.com",
		"GLITCHMONITOR_EXTERNAL_ROUTE_ENABLED":   "false",
		"GLITCHMONITOR_EXTERNAL_GATEWAY_URL":     "https://gm.gtw.other.example.com",
		"GLITCHMONITOR_BROWSER_INTERVAL_MS":      "50",
		"GLITCHMONITOR_BROWSER_FAIL_THRESHOLD":   "5",
		"GLITCHMONITOR_INTERNAL_TIMEOUT_MS":      "750",
		"GLITCHMONITOR_BROWSER_POD_WINDOW_SEC":   "",
		"GLITCHMONITOR_EXTERNAL_UNKNOWN_ENABLED": "true",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 9090 || time.Duration(cfg.Server.ShutdownDelay) != 1500*time.Millisecond {
		t.Errorf("server = %+v", cfg.Server)
	}
	if want := []string{"https://a.example.com", "https://b.example.com"}; !reflect.DeepEqual(cfg.CORSAllowedOrigins, want) {
		t.Errorf("corsAllowedOrigins = %v, want %v", cfg.CORSAllowedOrigins, want)
	}
	if cfg.External[0].Enabled {
		t.Error("route should be disabled by env")
	}
	if cfg.External[1].URL != "https://gm.gtw.other.example.com" {
		t.Errorf("gateway url = %q", cfg.External[1].URL)
	}
	if cfg.Browser.IntervalMs != 50 || cfg.Browser.FailThreshold != 5 || cfg.Internal.TimeoutMs != 750 {
		t.Errorf("browser = %+v internal = %+v", cfg.Browser, cfg.Internal)
	}
	if cfg.Browser.PodWindowSec != 5 {
		t.Errorf("empty env var must not override: podWindowSec = %d", cfg.Browser.PodWindowSec)
	}
}

func TestEnvName(t *testing.T) {
	if got := envName("my-gw.2"); got != "MY_GW_2" {
		t.Errorf("envName = %q", got)
	}
}

func TestInvalid(t *testing.T) {
	cases := []struct {
		name, yaml string
		env        map[string]string
		wantErr    string
	}{
		{name: "unknown key", yaml: "browser:\n  intervalMS: 100\n", wantErr: "intervalMS"},
		{name: "bad duration", yaml: "server:\n  shutdownDelay: soon\n", wantErr: "soon"},
		{name: "negative delay", yaml: "server:\n  shutdownDelay: -1s\n", wantErr: "negative"},
		{name: "port range", yaml: "server:\n  port: 70000\n", wantErr: "out of range"},
		{name: "zero interval", yaml: "browser:\n  intervalMs: 0\n", wantErr: "browser.intervalMs"},
		{name: "url scheme", yaml: "external:\n  - name: x\n    url: ftp://x\n", wantErr: "not an http(s) URL"},
		{name: "url path", yaml: "external:\n  - name: x\n    url: https://x/app\n", wantErr: "must not have a path"},
		{name: "missing name", yaml: "external:\n  - url: https://x\n", wantErr: "name is required"},
		{name: "duplicate name", yaml: "external:\n  - {name: x, url: 'https://x'}\n  - {name: x, url: 'https://y'}\n", wantErr: "duplicate"},
		{name: "bad origin", yaml: "corsAllowedOrigins: [example.com]\n", wantErr: "corsAllowedOrigins[0]"},
		{name: "bad mode", yaml: "internal:\n  targets:\n    service: {enabled: true, modes: [pooled]}\n", wantErr: "pooled"},
		{name: "connect timeout over the total", yaml: "internal:\n  connectTimeoutMs: 1500\n", wantErr: "connectTimeoutMs"},
		{name: "env not int", env: map[string]string{"GLITCHMONITOR_SERVER_PORT": "http"}, wantErr: "GLITCHMONITOR_SERVER_PORT"},
		{name: "env not duration", env: map[string]string{"GLITCHMONITOR_SERVER_SHUTDOWN_DELAY": "5"}, wantErr: "GLITCHMONITOR_SERVER_SHUTDOWN_DELAY"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := ""
			if tc.yaml != "" {
				path = writeFile(t, tc.yaml)
			}
			_, err := Load(path, env(tc.env))
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not mention %q", err, tc.wantErr)
			}
		})
	}
}

func TestWildcardOriginIsAccepted(t *testing.T) {
	cfg, err := Load(writeFile(t, "corsAllowedOrigins: ['*']\n"), env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg.CORSAllowedOrigins, []string{"*"}) {
		t.Errorf("corsAllowedOrigins = %v", cfg.CORSAllowedOrigins)
	}
}

func TestMissingFileIsAnError(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.yaml"), env(nil)); err == nil {
		t.Fatal("expected an error")
	}
}

// Kubernetes sets these in every pod of a namespace that has a Service named glitchmonitor.
func TestServiceLinkVariablesAreNotOverrides(t *testing.T) {
	cfg, err := Load("", env(map[string]string{
		"GLITCHMONITOR_PORT":              "tcp://172.30.0.10:8080",
		"GLITCHMONITOR_SERVICE_HOST":      "172.30.0.10",
		"GLITCHMONITOR_SERVICE_PORT":      "8080",
		"GLITCHMONITOR_SERVICE_PORT_HTTP": "8080",
		"GLITCHMONITOR_PORT_8080_TCP":     "tcp://172.30.0.10:8080",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg, Default()) {
		t.Errorf("got %+v, want defaults", cfg)
	}
}
