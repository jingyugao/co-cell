.PHONY: build up start down restart logs ps prepare-cocell-runtime build-cocell-runtime deploy-co-cell deploy-cellbox-server deploy-cellbox-controller deploy-cellbox-api deploy-cellbox-local-metadata deploy-cocell-sandbox deploy-debug-mount deploy-all

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

ifneq ($(COCELL_DEPLOY_ENV_LOADED),1)
prepare-cocell-runtime build-cocell-runtime deploy-co-cell deploy-cellbox-server deploy-cellbox-api deploy-cellbox-controller deploy-cellbox-local-metadata deploy-cocell-sandbox deploy-debug-mount deploy-all:
	node deploy/scripts/with-env.mjs $(MAKE) COCELL_DEPLOY_ENV_LOADED=1 $@
else
prepare-cocell-runtime:
	node deploy/scripts/cellbox/prepare-runtime-artifacts.mjs

build-cocell-runtime:
	node deploy/scripts/cellbox/build-offline-runtime.mjs

deploy-co-cell:
	deploy/scripts/k8s/deploy-co-cell.sh

deploy-cellbox-server:
	@test -n "$${CELLBOX_SOURCE_DIR:-}" || { echo "Set CELLBOX_SOURCE_DIR to the Cellbox source directory" >&2; exit 2; }
	@test -n "$${COCELL_REGISTRY_ENDPOINT:-}" || { echo "Set COCELL_REGISTRY_ENDPOINT to the local HTTP registry origin" >&2; exit 2; }
	@test -n "$${COCELL_CELLBOX_NODE_NAME:-}" || { echo "Set COCELL_CELLBOX_NODE_NAME to the dedicated Cellbox runtime node" >&2; exit 2; }
	@test -n "$${CELLBOX_PROFILE:-}" || { echo "Set CELLBOX_PROFILE to the configured Cellbox runtime profile" >&2; exit 2; }
	@test -z "$${COCELL_CELLBOX_STORAGE_HOST_PATH:-}" -o -z "$${COCELL_CELLBOX_STORAGE_CLAIM:-}" || { echo "Configure only one Cellbox storage hostPath or claim" >&2; exit 2; }
	uv run --no-project python deploy/scripts/k8s/deploy-cellbox-server.py "$$CELLBOX_SOURCE_DIR"

deploy-cellbox-api deploy-cellbox-controller deploy-cellbox-local-metadata:
	@echo "$@ is unsupported for Cellbox single-server releases; use deploy-cellbox-server. Legacy metadata is never imported automatically." >&2
	@exit 2

deploy-cocell-sandbox:
	@test -n "$${CELLBOX_SOURCE_DIR:-}" || { echo "Set CELLBOX_SOURCE_DIR to the Cellbox source directory" >&2; exit 2; }
	@test -n "$${COCELL_REGISTRY_ENDPOINT:-}" || { echo "Set COCELL_REGISTRY_ENDPOINT to the local HTTP registry origin" >&2; exit 2; }
	@test -n "$${CELLBOX_PROFILE:-}" -a -n "$${CELLBOX_CLIENT_ID:-}" || { echo "Set CELLBOX_PROFILE and CELLBOX_CLIENT_ID" >&2; exit 2; }
	@test -n "$${COCELL_SANDBOX_IMAGE_TAG:-}" || { echo "Set COCELL_SANDBOX_IMAGE_TAG to a new vMAJOR.MINOR.PATCH version" >&2; exit 2; }
	@test -n "$${CELLBOX_TEMPLATE_ID:-}$${CELLBOX_REVISION_ID:-}" -o "$${COCELL_CELLBOX_CREATE_TEMPLATE:-0}" = 1 || { echo "Set a template/revision selector or explicitly opt into first template creation" >&2; exit 2; }
	@if test -n "$${CELLBOX_TEMPLATE_ID:-}" && test -n "$${CELLBOX_REVISION_ID:-}"; then echo "Set at most one template/revision selector" >&2; exit 2; fi
	@if test "$${COCELL_CELLBOX_CREATE_TEMPLATE:-0}" = 1 && test -n "$${CELLBOX_TEMPLATE_ID:-}$${CELLBOX_REVISION_ID:-}"; then echo "Use selectors or create a new template family, not both" >&2; exit 2; fi
	deploy/scripts/cellbox/build-deploy-cocell-image.sh

deploy-debug-mount:
	@test -n "$${CELLBOX_SOURCE_DIR:-}" || { echo "Set CELLBOX_SOURCE_DIR to the Cellbox source directory" >&2; exit 2; }
	@test -n "$${COCELL_REGISTRY_ENDPOINT:-}" || { echo "Set COCELL_REGISTRY_ENDPOINT to the local HTTP registry origin" >&2; exit 2; }
	@test -n "$${COCELL_USER_BASE_IMAGE:-}" || { echo "Set COCELL_USER_BASE_IMAGE to the user-provided base image" >&2; exit 2; }
	@test -n "$${COCELL_DEBUG_READ_ONLY_HOST_PATH:-}$${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}" || { echo "Set a debug host path on the Kubernetes node" >&2; exit 2; }
	@test -z "$${COCELL_DEBUG_READ_ONLY_HOST_PATH:-}" -o -z "$${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}" || { echo "Configure only one debug host mount mode" >&2; exit 2; }
	@if test -n "$${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}"; then test -n "$${COCELL_DEBUG_HOST_UID:-}" && test -n "$${COCELL_DEBUG_HOST_GID:-}" || { echo "Set COCELL_DEBUG_HOST_UID and COCELL_DEBUG_HOST_GID" >&2; exit 2; }; fi
	@test -n "$${COCELL_SANDBOX_IMAGE_TAG:-}" || { echo "Set COCELL_SANDBOX_IMAGE_TAG to a new vMAJOR.MINOR.PATCH version" >&2; exit 2; }
	deploy/scripts/k8s/deploy-stack.sh debug

deploy-all:
	@test -n "$${CELLBOX_SOURCE_DIR:-}" || { echo "Set CELLBOX_SOURCE_DIR to the Cellbox source directory" >&2; exit 2; }
	deploy/scripts/k8s/deploy-stack.sh all
endif
