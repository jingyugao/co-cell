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

# Keep native CLI binaries intact. Dynamic tools enter through one dispatcher.
RUN mkdir -p /opt/cellbox/debug-bin \
  && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/product/cocell/tool-client.mjs --dynamic "$@"\n' > /usr/local/bin/cocell \
  && chmod 0755 /usr/local/bin/cocell \
  && node -e 'require("fs").writeFileSync("/opt/product/cocell/proxy-tool-ids.json",JSON.stringify(["cocell_tool"]))'
COPY --chmod=0644 deploy/box-wrap/tool-path.sh /etc/profile.d/cocell-tools.sh
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
