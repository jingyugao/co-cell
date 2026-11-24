FROM golang:1.26.0-bookworm AS go
FROM node:22.18.0-bookworm-slim
ARG CODEX_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=go /usr/local/go /usr/local/go
RUN ln -s /usr/local/go/bin/go /usr/local/bin/go
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local
RUN test -n "$CODEX_VERSION" && npm install --global "@openai/codex@$CODEX_VERSION"
COPY --chmod=0755 cellbox-container-agent /opt/cellbox/bin/cellbox-container-agent
COPY runtime-packages.json install-retain-hooks.mjs /opt/product/cocell/
RUN cd /opt/product/cocell && npm install --global "$(node -p 'require("./runtime-packages.json").hindsightHooks.url')" \
    && ln -s "$(npm root -g)/@vectorize-io/hindsight-coding-agents" hindsight && node install-retain-hooks.mjs
COPY acp /opt/product/cocell/acp
COPY launcher.mjs /opt/product/cocell/launcher.mjs
WORKDIR /home/agent/workspace
