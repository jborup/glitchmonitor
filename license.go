// SPDX-License-Identifier: AGPL-3.0-or-later

// Package glitchmonitor carries the licence texts, so the running app can show them.
package glitchmonitor

import (
	"bytes"
	"embed"
	"fmt"
	"io/fs"
)

//go:embed LICENSE
var License []byte

// The notices list and every third-party licence text: those kept under
// third_party/licenses, and those vendored next to frontend code.
//
//go:embed THIRD-PARTY-NOTICES.md third_party/licenses web/static/vendor/*/LICENSE*
var thirdParty embed.FS

// ThirdPartyNotices returns one plain-text document: the list of third-party
// components followed by the full text of each of their licence files.
func ThirdPartyNotices() []byte {
	var out bytes.Buffer
	notices, err := thirdParty.ReadFile("THIRD-PARTY-NOTICES.md")
	if err != nil {
		panic(err) // embedded at build time
	}
	out.Write(notices)
	err = fs.WalkDir(thirdParty, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || path == "THIRD-PARTY-NOTICES.md" {
			return err
		}
		text, err := thirdParty.ReadFile(path)
		if err != nil {
			return err
		}
		fmt.Fprintf(&out, "\n\n%s\n%s\n%s\n\n", rule, path, rule)
		out.Write(text)
		return nil
	})
	if err != nil {
		panic(err)
	}
	return out.Bytes()
}

const rule = "================================================================================"
