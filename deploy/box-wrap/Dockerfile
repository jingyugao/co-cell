# Prepare with make prepare-cocell-runtime, then build from the repository root:
# COCELL_RUNTIME_IMAGE=cocell-runtime:local make build-cocell-runtime
ARG COCELL_USER_BASE_IMAGE=node:22.18.0-bookworm-slim
FROM ${COCELL_USER_BASE_IMAGE}
USER root

# Cellbox adds its static guest binary and creates the agent/debug accounts in
# its final preparation layer. This image contains no operator credentials.
COPY deploy/box-wrap/runtime-packages.json /opt/product/cocell/deploy/box-wrap/
COPY deploy/scripts/cellbox/runtime-artifacts.mjs deploy/box-wrap/install-offline-runtime.sh /opt/product/cocell/deploy/scripts/cellbox/
# Preparation downloads and verifies packages before build. The read-only bind
# keeps archives out of image layers, and this installation has no network.
RUN --network=none --mount=type=bind,source=deploy/box-wrap/artifacts,target=/opt/cocell-artifacts \
    node /opt/product/cocell/deploy/scripts/cellbox/runtime-artifacts.mjs /opt/cocell-artifacts \
    && sh /opt/product/cocell/deploy/scripts/cellbox/install-offline-runtime.sh

# Preserve configured user CLIs before their proxy wrappers take those names.
ARG COCELL_PROXY_TOOLS=""
COPY deploy/box-wrap/proxy-tools.json /opt/product/cocell/
RUN mkdir -p /opt/cellbox/debug-bin \
  && proxy_ids='' \
  && for tool in ${COCELL_PROXY_TOOLS:-$(node -p 'JSON.parse(require("fs").readFileSync("/opt/product/cocell/proxy-tools.json")).join(" ")')}; do \
       binary="$(command -v "$tool" || true)"; \
       if test -z "$binary"; then continue; fi; \
       if test -x "/opt/cellbox/debug-bin/$tool"; then :; \
       elif test -L "$binary"; then ln -s "$(readlink -f "$binary")" "/opt/cellbox/debug-bin/$tool"; \
       else cp -L "$binary" "/opt/cellbox/debug-bin/$tool"; fi; \
       tool_id="cocell_$(echo "$tool" | tr '-' '_')"; \
       rm -f "/usr/local/bin/$tool"; \
       printf '#!/bin/sh\nexec /usr/local/bin/node /opt/product/cocell/tool-client.mjs %s "$@"\n' "$tool_id" > "/usr/local/bin/$tool"; \
       chmod 0755 "/usr/local/bin/$tool"; \
       proxy_ids="$proxy_ids $tool_id"; \
     done \
  && node -e 'require("fs").writeFileSync("/opt/product/cocell/proxy-tool-ids.json",JSON.stringify(process.argv.slice(1)))' $proxy_ids
COPY --chmod=0755 deploy/box-wrap/launcher.mjs deploy/box-wrap/oss-archive-restore.mjs /opt/product/cocell/
# Node resolves each entry to its immutable shared version before importing dependencies.
RUN ln -sfn /var/lib/cellbox/shared/tool-wrap/current/deploy/box-wrap/protected-tool.mjs /opt/product/cocell/protected-tool.mjs \
  && ln -sfn /var/lib/cellbox/shared/tool-wrap/current/deploy/box-wrap/tool-client.mjs /opt/product/cocell/tool-client.mjs
COPY --chmod=0755 deploy/box-wrap/tools/cocell-archive-restore /opt/cellbox/tools/cocell-archive-restore
COPY --chmod=0755 deploy/box-wrap/tools/cocell-proxy /opt/cellbox/tools/cocell-proxy
RUN --network=none node --check /opt/cellbox/tools/cocell-proxy
LABEL cocell.debug-home="1"
LABEL cocell.tool-wrap="mounted-v1"

ENV PATH=/usr/local/bin:/usr/bin:/bin
WORKDIR /home/agent/workspace
