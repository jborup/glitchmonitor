// SPDX-License-Identifier: AGPL-3.0-or-later

// Package glitchmonitor carries the licence text, so the running app can show it.
package glitchmonitor

import _ "embed"

//go:embed LICENSE
var License []byte
