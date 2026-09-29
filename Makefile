.PHONY: build up start down restart logs ps deploy-co-cell deploy-cellbox-controller deploy-cellbox-api deploy-cocell-sandbox deploy-debug-mount deploy-all

COMPOSE := docker compose
SERVICE := swarm-hive
build:
	$(COMPOSE) build $(SERVICE)

rebuild: build

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

deploy-co-cell:
	deploy/scripts/k8s/deploy-co-cell.sh

deploy-cellbox-api:
	@test -n "$${CELLBOX_SOURCE_DIR:-}" || { echo "Set CELLBOX_SOURCE_DIR to the Cellbox source directory" >&2; exit 2; }
	@test -n "$${COCELL_REGISTRY_ENDPOINT:-}" || { echo "Set COCELL_REGISTRY_ENDPOINT to the local HTTP registry origin" >&2; exit 2; }
	python3 deploy/scripts/k8s/deploy-cellbox-api.py "$$CELLBOX_SOURCE_DIR"

deploy-cellbox-controller:
	@test -n "$${CELLBOX_SOURCE_DIR:-}" || { echo "Set CELLBOX_SOURCE_DIR to the Cellbox source directory" >&2; exit 2; }
	@test -n "$${COCELL_REGISTRY_ENDPOINT:-}" || { echo "Set COCELL_REGISTRY_ENDPOINT to the local HTTP registry origin" >&2; exit 2; }
	python3 deploy/scripts/k8s/deploy-cellbox-controller.py "$$CELLBOX_SOURCE_DIR"

deploy-cocell-sandbox:
	@test -n "$${COCELL_REGISTRY_ENDPOINT:-}" || { echo "Set COCELL_REGISTRY_ENDPOINT to the local HTTP registry origin" >&2; exit 2; }
	deploy/scripts/cellbox/build-deploy-cocell-image.sh

deploy-debug-mount:
	@test -n "$${CELLBOX_SOURCE_DIR:-}" || { echo "Set CELLBOX_SOURCE_DIR to the Cellbox source directory" >&2; exit 2; }
	@test -n "$${COCELL_REGISTRY_ENDPOINT:-}" || { echo "Set COCELL_REGISTRY_ENDPOINT to the local HTTP registry origin" >&2; exit 2; }
	@test -n "$${COCELL_USER_BASE_IMAGE:-}" || { echo "Set COCELL_USER_BASE_IMAGE to the user-provided base image" >&2; exit 2; }
	@test -n "$${COCELL_DEBUG_READ_ONLY_HOST_PATH:-}$${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}" || { echo "Set a debug host path on the Kubernetes node" >&2; exit 2; }
	@test -z "$${COCELL_DEBUG_READ_ONLY_HOST_PATH:-}" -o -z "$${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}" || { echo "Configure only one debug host mount mode" >&2; exit 2; }
	@if test -n "$${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}"; then test -n "$${COCELL_DEBUG_HOST_UID:-}" && test -n "$${COCELL_DEBUG_HOST_GID:-}" || { echo "Set COCELL_DEBUG_HOST_UID and COCELL_DEBUG_HOST_GID" >&2; exit 2; }; fi
	@test -n "$${COCELL_SANDBOX_IMAGE_TAG:-}" || { echo "Set COCELL_SANDBOX_IMAGE_TAG to a new vMAJOR.MINOR.PATCH version" >&2; exit 2; }
	$(MAKE) -C "$$CELLBOX_SOURCE_DIR" build
	CELLBOX_SKIP_BUILD=1 $(MAKE) deploy-cellbox-controller
	CELLBOX_SKIP_BUILD=1 $(MAKE) deploy-cellbox-api
	$(MAKE) deploy-cocell-sandbox

deploy-all:
	@test -n "$${CELLBOX_SOURCE_DIR:-}" || { echo "Set CELLBOX_SOURCE_DIR to the Cellbox source directory" >&2; exit 2; }
	$(MAKE) -C "$$CELLBOX_SOURCE_DIR" build
	CELLBOX_SKIP_BUILD=1 $(MAKE) deploy-cellbox-controller
	CELLBOX_SKIP_BUILD=1 $(MAKE) deploy-cellbox-api
	$(MAKE) deploy-cocell-sandbox
	$(MAKE) deploy-co-cell
