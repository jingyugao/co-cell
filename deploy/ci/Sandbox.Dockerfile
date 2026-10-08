FROM node:22.18.0-bookworm-slim
ARG CODEX_VERSION
RUN test -n "$CODEX_VERSION" && npm install --global "@openai/codex@$CODEX_VERSION"
COPY --chmod=0755 cellbox-container-agent /opt/cellbox/bin/cellbox-container-agent
COPY launcher.mjs /opt/product/cocell/launcher.mjs
WORKDIR /home/agent/workspace
