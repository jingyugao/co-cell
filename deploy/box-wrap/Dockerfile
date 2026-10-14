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
RUN mkdir -p /opt/cellbox/debug-bin \
  && for tool in $COCELL_PROXY_TOOLS; do \
       binary="$(command -v "$tool")" || { echo "Proxy tool is missing: $tool" >&2; exit 1; }; \
       if test -L "$binary"; then ln -s "$(readlink -f "$binary")" "/opt/cellbox/debug-bin/$tool"; \
       else cp -L "$binary" "/opt/cellbox/debug-bin/$tool"; fi; \
     done
COPY --chmod=0755 deploy/box-wrap/launcher.mjs deploy/box-wrap/oss-archive-backup.mjs deploy/box-wrap/oss-archive-restore.mjs /opt/product/cocell/
COPY --chmod=0755 deploy/box-wrap/tool-client.mjs /opt/product/cocell/deploy/box-wrap/
COPY --chmod=0755 deploy/box-wrap/protected-tool.mjs /opt/product/cocell/deploy/box-wrap/
COPY util/tool-working-directory.mjs /opt/product/cocell/util/
COPY util/gitlab-tool-host.mjs /opt/product/cocell/util/
COPY util/tool-runtime-identity.mjs /opt/product/cocell/util/
# Preserve the public tool entry while resolving imports against the source layout.
RUN ln -s deploy/box-wrap/protected-tool.mjs /opt/product/cocell/protected-tool.mjs
RUN ln -s deploy/box-wrap/tool-client.mjs /opt/product/cocell/tool-client.mjs
COPY --chmod=0755 deploy/box-wrap/tools/cocell-archive-backup /opt/cellbox/tools/cocell-archive-backup
COPY --chmod=0755 deploy/box-wrap/tools/cocell-archive-restore /opt/cellbox/tools/cocell-archive-restore
COPY --chmod=0755 deploy/box-wrap/tools/cocell-proxy /opt/cellbox/tools/cocell-proxy
RUN --network=none node --input-type=module -e 'import {runProtectedTool} from "/opt/product/cocell/protected-tool.mjs"; if (typeof runProtectedTool !== "function") process.exit(1)'
LABEL cocell.debug-home="1"

ENV PATH=/usr/local/bin:/usr/bin:/bin
WORKDIR /home/agent/workspace
