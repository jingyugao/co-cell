.PHONY: build up start down restart logs ps

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
