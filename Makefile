.PHONY: build sandbox-build up start down restart logs ps

COMPOSE := docker compose
SERVICE := swarm-hive
SANDBOX_IMAGE ?= $(shell $(COMPOSE) config --format json | jq -r '.services["swarm-hive"].environment.DOCKER_SANDBOX_IMAGE')

sandbox-build:
	docker build -f docker/sandbox/Dockerfile -t $(SANDBOX_IMAGE) .

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
