// SPDX-License-Identifier: AGPL-3.0-or-later

package glitchmonitor

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A dependency cannot be added without its notice and its licence text.
func TestEveryThirdPartyComponentHasANotice(t *testing.T) {
	notices, err := os.ReadFile("THIRD-PARTY-NOTICES.md")
	if err != nil {
		t.Fatal(err)
	}
	served := string(ThirdPartyNotices())

	gomod, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	// Every required module, direct or indirect: all of them end up in the binary.
	requires := regexp.MustCompile(`(?m)^(?:require\s+|\t)([^\s()]+)\s+(v\S+)`).FindAllStringSubmatch(string(gomod), -1)
	if len(requires) == 0 {
		t.Fatal("found no requirements in go.mod")
	}
	for _, m := range requires {
		module, version := m[1], m[2]
		if !strings.Contains(string(notices), "### "+module+" "+version+"\n") {
			t.Errorf("THIRD-PARTY-NOTICES.md has no section %q", "### "+module+" "+version)
		}
		dir := filepath.Join("third_party", "licenses", strings.ReplaceAll(module, "/", "-"))
		requireLicenceFile(t, dir, served)
	}

	vendored, err := os.ReadDir(filepath.Join("web", "static", "vendor"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range vendored {
		dir := filepath.Join("web", "static", "vendor", entry.Name())
		if !strings.Contains(string(notices), "`"+filepath.ToSlash(dir)+"`") {
			t.Errorf("THIRD-PARTY-NOTICES.md does not mention %s", dir)
		}
		requireLicenceFile(t, dir, served)
	}

	// The Go runtime is in every binary, without appearing in go.mod.
	requireLicenceFile(t, filepath.Join("third_party", "licenses", "go"), served)
}

// requireLicenceFile checks that dir holds a LICENSE file and that the app serves its text.
func requireLicenceFile(t *testing.T, dir, served string) {
	t.Helper()
	matches, _ := filepath.Glob(filepath.Join(dir, "LICENSE*"))
	if len(matches) == 0 {
		t.Errorf("%s has no LICENSE file", dir)
		return
	}
	for _, path := range matches {
		text, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(served, filepath.ToSlash(path)) || !strings.Contains(served, string(text)) {
			t.Errorf("%s is not part of the notices the app serves", path)
		}
	}
}
