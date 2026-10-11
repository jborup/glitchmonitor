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
COPY LICENSE THIRD-PARTY-NOTICES.md license.go ./
COPY third_party ./third_party
COPY docs/demo ./docs/demo
COPY cmd ./cmd
COPY internal ./internal
COPY web ./web
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION -X main.sourceURL=$SOURCE_URL" -o /out/glitchmonitor ./cmd/glitchmonitor

FROM registry.access.redhat.com/ubi9/ubi-micro:latest
COPY --from=build /out/glitchmonitor /usr/local/bin/glitchmonitor
# The licence texts travel with the binary that contains the code.
COPY LICENSE THIRD-PARTY-NOTICES.md /licenses/
COPY third_party/licenses /licenses/third_party
COPY web/static/vendor/uplot/LICENSE /licenses/third_party/uplot/LICENSE
USER 1001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/glitchmonitor"]
CMD ["serve"]
