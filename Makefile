# SPDX-License-Identifier: AGPL-3.0-or-later

# Your own registry, overlay and other settings go in local.mk, which is not committed.
-include local.mk

REGISTRY  ?= registry.example.com
VERSION   ?= 0.2.2
# Where users of the image can get its source (AGPL section 13). Change it when you build a modified version.
SOURCE_URL ?= https://github.com/jborup/glitchmonitor
LDFLAGS   = -s -w -X main.version=$(VERSION) -X main.sourceURL=$(SOURCE_URL)
IMAGE     ?= $(REGISTRY)/glitchmonitor:$(VERSION)
PLATFORM  ?= linux/amd64
CONTAINER ?= podman
OVERLAY   ?= example

.PHONY: build test image push deploy

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/glitchmonitor ./cmd/glitchmonitor

test:
	go vet ./...
	GLITCHMONITOR_REQUIRE_DEPLOY_TOOLS=1 go test -race ./...
	helm lint --quiet deploy/chart/glitchmonitor
	node --test web/test/

image:
	$(CONTAINER) build --platform $(PLATFORM) --build-arg VERSION=$(VERSION) --build-arg SOURCE_URL=$(SOURCE_URL) -f Containerfile -t $(IMAGE) .

push:
	$(CONTAINER) push $(IMAGE)

# The image deployed is the one named in deploy/overlays/$(OVERLAY)/kustomization.yaml.
deploy:
	oc apply -k deploy/overlays/$(OVERLAY)
