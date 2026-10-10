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
	about := server.About{
		Version: version, SourceURL: sourceURL,
		License: glitchmonitor.License, ThirdParty: glitchmonitor.ThirdPartyNotices(),
	}
	return server.New(cfg, id, about, static, log).Run(ctx, ln)
}
