# Build from the repository root: docker build -f deploy/box-wrap/Dockerfile .
ARG COCELL_USER_BASE_IMAGE=node:22.18.0-bookworm-slim
FROM ${COCELL_USER_BASE_IMAGE}
USER root

# Cellbox adds its static guest binary and creates the agent/debug accounts in
# its final preparation layer. This image contains no operator credentials.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && test "$(node --version)" = "v22.18.0"

# CoCell owns the agent and archive CLIs; the user base supplies project tools.
RUN npm install --global @openai/codex@latest \
  && codex --version | grep -E '^codex-cli [0-9]+\.[0-9]+\.[0-9]+$'
RUN curl --fail --silent --show-error --location \
    https://github.com/restic/restic/releases/download/v0.18.1/restic_0.18.1_linux_amd64.bz2 \
    --output /tmp/restic.bz2 \
  && bzip2 --decompress --stdout /tmp/restic.bz2 > /tmp/restic \
  && echo "01143daba61a1dc8afb0cb3d03ba83e6b118f55b6b146b27473a09efc3df13d6  /tmp/restic" | sha256sum --check \
  && install -m 0755 /tmp/restic /usr/local/bin/restic \
  && restic version | grep -F 'restic 0.18.1 ' \
  && rm /tmp/restic /tmp/restic.bz2
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
COPY util/credential-files.mjs /opt/product/cocell/util/
COPY util/gitlab-tool-host.mjs /opt/product/cocell/util/
# Preserve the public tool entry while resolving imports against the source layout.
RUN ln -s deploy/box-wrap/protected-tool.mjs /opt/product/cocell/protected-tool.mjs
RUN ln -s deploy/box-wrap/tool-client.mjs /opt/product/cocell/tool-client.mjs
COPY --chmod=0755 deploy/box-wrap/tools/cocell-archive-backup /opt/cellbox/tools/cocell-archive-backup
COPY --chmod=0755 deploy/box-wrap/tools/cocell-archive-restore /opt/cellbox/tools/cocell-archive-restore
COPY --chmod=0755 deploy/box-wrap/tools/cocell-proxy /opt/cellbox/tools/cocell-proxy

ENV PATH=/usr/local/bin:/usr/bin:/bin
WORKDIR /home/agent/workspace
