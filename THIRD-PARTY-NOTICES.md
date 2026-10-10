# Third-party notices

glitchmonitor itself is licensed under AGPL-3.0-or-later (see [LICENSE](LICENSE)).
It includes the third-party components below, each under its own licence. Their
licence texts are in this repository at the paths given, in the container image
under `/licenses/third_party`, and served by the running app at
`/THIRD-PARTY-NOTICES`.

`make test` checks that every Go module in `go.mod` and every directory under
`web/static/vendor` is listed here with its licence file.

## Delivered to the browser

### uPlot 1.6.32

- Used for: the latency timeline.
- Source: https://github.com/leeoniya/uPlot
- Licence: MIT. Copyright (c) 2022 Leon Sorokin.
- Licence text: `web/static/vendor/uplot/LICENSE`
- Vendored unmodified in `web/static/vendor/uplot`.

## Compiled into the binary

### go.yaml.in/yaml/v3 v3.0.5

- Used for: reading the configuration file.
- Source: https://github.com/yaml/go-yaml
- Licence: MIT for the files ported from libyaml, Copyright (c) 2006-2011 Kirill
  Simonov; Apache-2.0 for the rest, Copyright (c) 2011-2019 Canonical Ltd.
- Licence texts: `third_party/licenses/go.yaml.in-yaml-v3/` (`LICENSE`, `NOTICE`
  and the full `Apache-2.0.txt`)

### Go standard library and runtime

- Used for: everything; the Go toolchain links them into the binary.
- Source: https://go.dev
- Licence: BSD-3-Clause. Copyright 2009 The Go Authors.
- Licence text: `third_party/licenses/go/LICENSE`

## Container image only

The published container image is built on Red Hat Universal Base Image 9 Micro,
which Red Hat distributes under its Universal Base Image End User License
Agreement. Nothing from it is part of this repository or of the binary.
