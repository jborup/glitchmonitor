# SPDX-License-Identifier: AGPL-3.0-or-later

# Build on the native platform and cross-compile, so no emulation is needed.
FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.26 AS build
ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
ARG SOURCE_URL=https://github.com/jborup/glitchmonitor
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY LICENSE license.go ./
COPY cmd ./cmd
COPY internal ./internal
COPY web ./web
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION -X main.sourceURL=$SOURCE_URL" -o /out/glitchmonitor ./cmd/glitchmonitor
# Third-party licence texts travel with the binary that contains the code.
RUN d=$(go list -m -f '{{.Dir}}' go.yaml.in/yaml/v3) && mkdir -p /out/licenses/go.yaml.in-yaml-v3 && \
    cp "$d"/LICENSE* "$d"/NOTICE* /out/licenses/go.yaml.in-yaml-v3/

FROM registry.access.redhat.com/ubi9/ubi-micro:latest
COPY --from=build /out/glitchmonitor /usr/local/bin/glitchmonitor
COPY LICENSE /licenses/LICENSE
COPY --from=build /out/licenses /licenses/third_party
USER 1001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/glitchmonitor"]
CMD ["serve"]
