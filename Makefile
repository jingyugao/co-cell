.PHONY: build sandbox-build sandbox-version up start down restart logs ps

COMPOSE := docker compose
SERVICE := swarm-hive
SANDBOX_IMAGE ?= $(shell $(COMPOSE) config --format json | jq -r '.services["swarm-hive"].environment.DOCKER_SANDBOX_IMAGE')
SANDBOX_REVISION ?= $(shell git rev-parse --verify --short HEAD 2>/dev/null || echo unknown)
SANDBOX_VERSION_FILE ?= docker/sandbox/VERSION
# Keep rebuilds deterministic: bump the checked-in VERSION file for a release,
# or use `make sandbox-build SANDBOX_VERSION=0.1.2` for an explicit override.
SANDBOX_VERSION ?= $(shell sed -e 's/[[:space:]]//g' $(SANDBOX_VERSION_FILE))
SANDBOX_CREATED ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
# Keep an immutable local tag in addition to the deployment reference (usually
# `swarm-hive-sandbox:latest`). It makes older images inspectable after latest
# moves forward. Override this for a registry naming scheme if needed.
SANDBOX_VERSIONED_IMAGE ?= swarm-hive-sandbox:$(SANDBOX_VERSION)

sandbox-version:
	@printf '%s\n' '$(SANDBOX_VERSION)'

sandbox-build:
	docker build -f docker/sandbox/Dockerfile \
		--build-arg SANDBOX_VERSION=$(SANDBOX_VERSION) \
		--build-arg SANDBOX_REVISION=$(SANDBOX_REVISION) \
		--build-arg SANDBOX_CREATED=$(SANDBOX_CREATED) \
		-t $(SANDBOX_IMAGE) -t $(SANDBOX_VERSIONED_IMAGE) .

build: sandbox-build
	$(COMPOSE) build $(SERVICE)

up: build
	$(COMPOSE) up -d

start:
	$(COMPOSE) start

down:
	$(COMPOSE) down

restart: build
	$(COMPOSE) up -d

logs:
	$(COMPOSE) logs -f $(SERVICE)

ps:
	$(COMPOSE) ps
