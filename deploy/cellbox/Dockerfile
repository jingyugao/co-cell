ARG COCELL_USER_BASE_IMAGE=node:22.18.0-bookworm-slim
FROM ${COCELL_USER_BASE_IMAGE}
USER root

# Cellbox adds its static guest binary and creates the agent/debug accounts in
# its final preparation layer. This image contains no operator credentials.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @openai/codex@0.153.4 \
  && test "$(node --version)" = "v22.18.0" \
  && test "$(codex --version)" = "codex-cli 0.153.4"
# Preserve optional user-provided CLIs before the agent-facing wrappers take
# their names on PATH. Missing tools stay unavailable instead of being added.
RUN mkdir -p /opt/cellbox/debug-bin \
  && for tool in mysql kubectl; do \
       binary="$(command -v "$tool" || true)"; \
       if [ -n "$binary" ]; then cp -L "$binary" "/opt/cellbox/debug-bin/$tool"; fi; \
     done
COPY --chmod=0755 launcher.mjs oss-archive-backup.mjs oss-archive-restore.mjs /opt/product/cocell/
COPY --chmod=0755 tool-client.mjs /opt/product/cocell/tool-client.mjs
COPY --chmod=0755 tools/cocell-cli /opt/cellbox/tools/cocell-cli
COPY --chmod=0755 tools/cocell-archive-backup /opt/cellbox/tools/cocell-archive-backup
COPY --chmod=0755 tools/cocell-archive-restore /opt/cellbox/tools/cocell-archive-restore
COPY --chmod=0755 wrappers/mysql wrappers/kubectl /usr/local/bin/

ENV PATH=/usr/local/bin:/usr/bin:/bin
WORKDIR /home/agent/workspace
