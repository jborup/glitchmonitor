// SPDX-License-Identifier: AGPL-3.0-or-later

// Package web holds the single-page dashboard, embedded into the binary.
package web

import "embed"

//go:embed static
var Static embed.FS
