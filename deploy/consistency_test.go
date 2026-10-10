// SPDX-License-Identifier: AGPL-3.0-or-later

// Package deploy checks that the two ways to deploy, the kustomize overlays
// and the Helm chart, render the same objects.
package deploy

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const chartDir = "chart/glitchmonitor"

// `make test` sets this, so a missing helm or oc fails the check instead of skipping it.
const requireToolsEnv = "GLITCHMONITOR_REQUIRE_DEPLOY_TOOLS"

type object = map[string]any

func TestKustomizeAndHelmRenderTheSameObjects(t *testing.T) {
	kustomize := findTool(t, []string{"oc", "kustomize"}, []string{"kubectl", "kustomize"}, []string{"kustomize", "build"})
	helm := findTool(t, []string{"helm", "template", "glitchmonitor", chartDir, "--namespace", "glitchmonitor"})
	readInputs(t)

	// Every overlay overlays/<name> must match the chart rendered with
	// values/<name>.yaml. Overlays that are not committed are checked too.
	overlays, err := os.ReadDir("overlays")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range overlays {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		t.Run(name, func(t *testing.T) {
			values := "values/" + name + ".yaml"
			if _, err := os.Stat(values); err != nil {
				t.Fatalf("overlays/%s has no matching chart values file: %v", name, err)
			}
			fromKustomize := normalize(t, render(t, append(slices.Clone(kustomize), "overlays/"+name)))
			fromHelm := normalize(t, render(t, append(slices.Clone(helm), "--values", values)))

			for _, key := range unionKeys(fromKustomize, fromHelm) {
				k, inK := fromKustomize[key]
				h, inH := fromHelm[key]
				switch {
				case !inH:
					t.Errorf("%s: in the kustomize overlay but not in the chart", key)
				case !inK:
					t.Errorf("%s: in the chart but not in the kustomize overlay", key)
				case !reflect.DeepEqual(k, h):
					t.Errorf("%s differs\n--- kustomize\n%s--- helm\n%s", key, dump(k), dump(h))
				}
			}
		})
	}
}

// The Makefile tags the image it builds; the chart and overlays say which tag to run.
func TestMakefileVersionMatchesChart(t *testing.T) {
	makefile, err := os.ReadFile("../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^VERSION\s*\?=\s*(\S+)`).FindSubmatch(makefile)
	if m == nil {
		t.Fatal("no VERSION in the Makefile")
	}
	data, err := os.ReadFile(chartDir + "/Chart.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var chart struct {
		Version    string `yaml:"version"`
		AppVersion string `yaml:"appVersion"`
	}
	if err := yaml.Unmarshal(data, &chart); err != nil {
		t.Fatal(err)
	}
	if string(m[1]) != chart.AppVersion || chart.Version != chart.AppVersion {
		t.Errorf("Makefile VERSION %s, chart version %s, chart appVersion %s: all three must be equal",
			m[1], chart.Version, chart.AppVersion)
	}
}

// readInputs reads every manifest through this process. helm and kustomize
// read them too, but Go only reruns a cached test when a file the test itself
// opened has changed.
func readInputs(t *testing.T) {
	t.Helper()
	for _, dir := range []string{"base", "components", "overlays", "chart", "values"} {
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			_, err = os.ReadFile(path)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

// findTool returns the first candidate command whose binary is installed.
func findTool(t *testing.T, candidates ...[]string) []string {
	t.Helper()
	var names []string
	for _, c := range candidates {
		if _, err := exec.LookPath(c[0]); err == nil {
			return c
		}
		names = append(names, c[0])
	}
	msg := "none of these is installed: " + strings.Join(names, ", ")
	if os.Getenv(requireToolsEnv) != "" {
		t.Fatal(msg)
	}
	t.Skip(msg)
	return nil
}

func render(t *testing.T, argv []string) []byte {
	t.Helper()
	cmd := exec.Command(argv[0], argv[1:]...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%s: %v\n%s", strings.Join(argv, " "), err, stderr.String())
	}
	return out
}

// Helm adds these; they say who manages the object, not what it is.
var helmLabels = []string{
	"app.kubernetes.io/instance",
	"app.kubernetes.io/managed-by",
	"app.kubernetes.io/version",
	"helm.sh/chart",
}

// kustomize appends a content hash to the generated ConfigMap's name.
var hashedConfigName = regexp.MustCompile(`^glitchmonitor-config-[a-z0-9]{10}$`)

// normalize parses a rendered stream into objects keyed by "Kind/name" and
// removes the differences that are inherent to the two tools:
//   - the Namespace object: kustomize creates it, a Helm release is installed into one
//   - metadata.namespace: kustomize writes it, Helm applies it at install time
//   - Helm's ownership labels
//   - how a config change rolls the pods: a hashed ConfigMap name in kustomize,
//     a checksum annotation in Helm
//
// The ConfigMap's config.yaml is compared as parsed YAML, not as text.
func normalize(t *testing.T, stream []byte) map[string]object {
	t.Helper()
	objects := map[string]object{}
	dec := yaml.NewDecoder(bytes.NewReader(stream))
	for {
		var o object
		if err := dec.Decode(&o); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if o == nil {
			continue
		}
		kind, _ := o["kind"].(string)
		if kind == "Namespace" {
			continue
		}
		meta := child(o, "metadata")
		delete(meta, "namespace")
		dropKeys(meta, "labels", helmLabels...)
		if name, _ := meta["name"].(string); hashedConfigName.MatchString(name) {
			meta["name"] = "glitchmonitor-config"
		}

		switch kind {
		case "ConfigMap":
			data := child(o, "data")
			var parsed any
			if err := yaml.Unmarshal([]byte(data["config.yaml"].(string)), &parsed); err != nil {
				t.Fatalf("config.yaml in the ConfigMap: %v", err)
			}
			data["config.yaml"] = parsed
		case "Deployment":
			template := child(child(o, "spec"), "template")
			dropKeys(child(template, "metadata"), "annotations", "checksum/config")
			for _, v := range child(template, "spec")["volumes"].([]any) {
				cm := child(v.(object), "configMap")
				if name, _ := cm["name"].(string); hashedConfigName.MatchString(name) {
					cm["name"] = "glitchmonitor-config"
				}
			}
		}

		key := kind + "/" + meta["name"].(string)
		if _, dup := objects[key]; dup {
			t.Fatalf("%s rendered twice", key)
		}
		objects[key] = o
	}
	if len(objects) == 0 {
		t.Fatal("rendered no objects")
	}
	return objects
}

// child returns m[key] as a map, or an empty map when it is absent.
func child(m object, key string) object {
	c, _ := m[key].(object)
	if c == nil {
		return object{}
	}
	return c
}

// dropKeys deletes keys from the map at parent[field], and the map itself once it is empty.
func dropKeys(parent object, field string, keys ...string) {
	m, ok := parent[field].(object)
	if !ok {
		return
	}
	for _, k := range keys {
		delete(m, k)
	}
	if len(m) == 0 {
		delete(parent, field)
	}
}

func unionKeys(a, b map[string]object) []string {
	seen := map[string]bool{}
	for k := range a {
		seen[k] = true
	}
	for k := range b {
		seen[k] = true
	}
	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func dump(o object) string {
	out, err := yaml.Marshal(o)
	if err != nil {
		return err.Error()
	}
	return string(out)
}
