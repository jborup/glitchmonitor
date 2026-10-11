// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"glitchmonitor"
	"glitchmonitor/internal/config"
	"glitchmonitor/internal/internalprobe"
	"glitchmonitor/internal/kube"
	"glitchmonitor/internal/server"
	"glitchmonitor/web"
)

// defaultConfigPath is where the Deployment mounts the ConfigMap.
const defaultConfigPath = "/etc/glitchmonitor/config.yaml"

// Set at build time with -ldflags "-X main.version=... -X main.sourceURL=...".
// sourceURL is where users of this build can get its source; anyone running a
// modified build must point it at their own source (AGPL section 13).
var (
	version   = "dev"
	sourceURL = "https://github.com/jborup/glitchmonitor"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		if err := serve(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "glitchmonitor:", err)
			os.Exit(1)
		}
	case "version":
		fmt.Println(version)
	case "notices":
		os.Stdout.Write(glitchmonitor.ThirdPartyNotices())
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "glitchmonitor: unknown command %q\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage: glitchmonitor <command>

commands:
  serve [--config FILE]   serve the dashboard and the probe endpoints
  version                 print the version
  notices                 print the third-party notices and licence texts
`)
}

func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	path := flags.String("config", os.Getenv(config.EnvPrefix+"CONFIG"),
		"YAML config file (default "+defaultConfigPath+" when it exists)")
	flags.Parse(args)

	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))

	if *path == "" {
		if _, err := os.Stat(defaultConfigPath); err == nil {
			*path = defaultConfigPath
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	cfg, err := config.Load(*path, os.Getenv)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	static, err := fs.Sub(web.Static, "static")
	if err != nil {
		return err
	}
	id := server.Identity{
		Pod:       os.Getenv("POD_NAME"),
		Node:      os.Getenv("NODE_NAME"),
		PodIP:     os.Getenv("POD_IP"),
		Namespace: os.Getenv("POD_NAMESPACE"),
	}
	if id.Pod == "" {
		id.Pod, _ = os.Hostname()
	}

	ln, err := net.Listen("tcp", ":"+strconv.Itoa(cfg.Server.Port))
	if err != nil {
		return err
	}
	log.Info("glitchmonitor serving", "version", version, "addr", ln.Addr().String(),
		"config", *path, "pod", id.Pod, "node", id.Node, "podIP", id.PodIP,
		"corsAllowedOrigins", cfg.CORSAllowedOrigins)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	srv := server.New(cfg, id, server.About{
		Version: version, SourceURL: sourceURL,
		License: glitchmonitor.License, ThirdParty: glitchmonitor.ThirdPartyNotices(),
		Samples: glitchmonitor.SampleRuns(),
	}, static, log)
	if id.Namespace != "" {
		srv.Internal = startInternalProbes(ctx, cfg, id, log)
	} else {
		log.Info("POD_NAMESPACE is not set: not in a cluster, so no internal probes")
	}
	return srv.Run(ctx, ln)
}

// The names the manifests give the two Services; the internal probes address them.
const (
	serviceName      = "glitchmonitor"
	peersServiceName = "glitchmonitor-peers"
)

func startInternalProbes(ctx context.Context, cfg *config.Config, id server.Identity, log *slog.Logger) *internalprobe.Manager {
	port := strconv.Itoa(cfg.Server.Port)
	opts := internalprobe.Options{
		Config:     cfg,
		Pod:        id.Pod,
		Node:       id.Node,
		PodIP:      id.PodIP,
		ServiceURL: fmt.Sprintf("http://%s.%s.svc:%s/api/ping", serviceName, id.Namespace, port),
		PeersHost:  fmt.Sprintf("%s.%s.svc", peersServiceName, id.Namespace),
		PodURL:     func(ip string) string { return "http://" + net.JoinHostPort(ip, port) + "/api/ping" },
		Log:        log,
	}
	api, err := kube.LoadInCluster()
	if err != nil {
		log.Warn("no API server access: no API server probe and no endpoint tagging", "error", err.Error())
	} else {
		opts.APIServer = api
		endpoints := kube.NewEndpoints(api, id.Namespace, serviceName, log)
		go endpoints.Run(ctx)
		opts.Endpoints = endpoints
	}
	m := internalprobe.New(opts)
	go m.Run(ctx)
	return m
}
