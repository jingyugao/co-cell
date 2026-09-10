.PHONY: build up start down restart logs ps

COMPOSE := docker compose
SERVICE := swarm-hive

build:
	$(COMPOSE) build $(SERVICE)

up:
	$(COMPOSE) up -d --build

start:
	$(COMPOSE) start

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) up -d --build

logs:
	$(COMPOSE) logs -f $(SERVICE)

ps:
	$(COMPOSE) ps
