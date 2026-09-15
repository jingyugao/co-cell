# syntax=docker/dockerfile:1.7
FROM node:22.18.0-bookworm-slim

# The mutable `latest` tag is convenient for new Sandboxes, but is not enough
# to identify the runtime an existing container was created from. Keep a human
# readable build version and its source revision in the immutable image config.
ARG SANDBOX_VERSION=0.1.1
ARG SANDBOX_REVISION=unknown
ARG SANDBOX_CREATED=unknown
LABEL org.opencontainers.image.title="swarm-hive-sandbox" \
      org.opencontainers.image.version="${SANDBOX_VERSION}" \
      org.opencontainers.image.revision="${SANDBOX_REVISION}" \
      org.opencontainers.image.created="${SANDBOX_CREATED}"

# This is the disposable project runtime, not the web application image. The
# host deliberately mounts Docker's socket into the web service and creates a
# fresh container from this image for every project sandbox.
# pnpm is installed directly rather than via Corepack: a disposable Sandbox can
# otherwise retain a broken Corepack shim when its download cache is absent.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
  && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
    bash ca-certificates curl git openssh-client \
    make g++ procps rsync tar gzip unzip \
  && rm -rf /var/lib/apt/lists/* \
  && if getent passwd 1000 >/dev/null; then existing_user="$(getent passwd 1000 | cut -d: -f1)"; if [ "$existing_user" != user ]; then usermod -l user "$existing_user"; fi; else useradd --uid 1000 --create-home --shell /bin/bash user; fi \
  && if getent group 1000 >/dev/null; then existing_group="$(getent group 1000 | cut -d: -f1)"; if [ "$existing_group" != user ]; then groupmod -n user "$existing_group"; fi; else groupadd --gid 1000 user; fi \
  && usermod -g user user

# example-backend's maintained Dockerfile uses PHP 8.0, while its current
# unlocked vendor tree contains dependencies requiring PHP 8.2. Install both
# co-installable versions with the same application extensions. PHP 8.2 is the
# default for the current vendor tree; legacy branches can invoke php8.0.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  curl --connect-timeout 20 --max-time 120 -fsSLo /tmp/debsuryorg-archive-keyring.deb https://packages.sury.org/debsuryorg-archive-keyring.deb \
  && dpkg -i /tmp/debsuryorg-archive-keyring.deb \
  && rm /tmp/debsuryorg-archive-keyring.deb \
  && printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ bookworm main' > /etc/apt/sources.list.d/php.list \
  && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    composer \
    php8.0-cli php8.0-bcmath php8.0-curl php8.0-gd php8.0-intl php8.0-mbstring \
    php8.0-mysql php8.0-redis php8.0-sockets php8.0-xml php8.0-yaml php8.0-zip \
    php8.2-cli php8.2-bcmath php8.2-curl php8.2-gd php8.2-intl php8.2-mbstring \
    php8.2-mysql php8.2-redis php8.2-sockets php8.2-xml php8.2-yaml php8.2-zip \
  && update-alternatives --set php /usr/bin/php8.2 \
  && php --version | grep -F 'PHP 8.2.' \
  && php -r 'foreach (["pdo_mysql", "mysqli", "bcmath", "gd", "zip", "sockets", "redis", "yaml"] as $extension) { if (!extension_loaded($extension)) { fwrite(STDERR, "missing PHP extension: $extension\\n"); exit(1); } }' \
  && rm -rf /var/lib/apt/lists/*

# Downloads are retained by the local BuildKit cache, not baked into the image.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm install --global pnpm@10.33.4 @openai/codex@0.153.4 \
  && curl -fsSL https://mise.run -o /tmp/install-mise.sh \
  && MISE_INSTALL_PATH=/usr/local/bin/mise sh /tmp/install-mise.sh \
  && rm /tmp/install-mise.sh \
  && curl -LsSf https://astral.sh/uv/install.sh -o /tmp/install-uv.sh \
  && UV_INSTALL_DIR=/usr/local/bin sh /tmp/install-uv.sh \
  && rm /tmp/install-uv.sh

# Keep the runtime manifest in its own layer: runtime changes do not invalidate
# OS package or CLI bootstrap caches.
COPY docker/sandbox/mise.toml /tmp/mise.toml
RUN --mount=type=cache,target=/home/user/.cache/mise,uid=1000,gid=1000 \
    --mount=type=cache,target=/home/user/.cache/uv,uid=1000,gid=1000 \
  install -d -o user -g user /home/user/.config/mise /home/user/.local/share/mise /home/user/.local/state/mise \
  && cp /tmp/mise.toml /home/user/.config/mise/config.toml \
  && chown user:user /home/user/.config/mise/config.toml \
  && su -s /bin/bash user -c 'export HOME=/home/user MISE_DATA_DIR=/home/user/.local/share/mise MISE_CONFIG_DIR=/home/user/.config/mise MISE_STATE_DIR=/home/user/.local/state/mise MISE_CACHE_DIR=/home/user/.cache/mise; mise trust /home/user/.config/mise/config.toml && mise install go@1.21.0 go@1.22 go@1.22.1 go@1.22.2 go@1.23 go@1.23.0 go@1.24 go@1.25 python@3.10 python@3.11 python@3.12 python@3.13 python@3.14 node@18 node@22.18.0 && mise reshim' \
  && node --version \
  && pnpm --version \
  && su -s /bin/bash user -c 'HOME=/home/user MISE_DATA_DIR=/home/user/.local/share/mise MISE_CONFIG_DIR=/home/user/.config/mise MISE_STATE_DIR=/home/user/.local/state/mise mise exec python@3.14 -- python --version' \
  && uv --version \
  && su -s /bin/bash user -c 'HOME=/home/user MISE_DATA_DIR=/home/user/.local/share/mise MISE_CONFIG_DIR=/home/user/.config/mise MISE_STATE_DIR=/home/user/.local/state/mise mise exec go@1.25 -- go version' \
  && su -s /bin/bash user -c 'HOME=/home/user MISE_DATA_DIR=/home/user/.local/share/mise MISE_CONFIG_DIR=/home/user/.config/mise MISE_STATE_DIR=/home/user/.local/state/mise mise exec node@18 -- node --version' \
  && php --version \
  && composer --version

# Public command-line tools are part of the immutable Sandbox image. Credentials
# are mounted separately at runtime and never enter an image layer.
COPY scripts/sandbox/install-command-tools.sh /usr/local/sbin/install-command-tools
RUN bash /usr/local/sbin/install-command-tools \
  && rm /usr/local/sbin/install-command-tools \
  && mkdir -p /home/user/workspace /home/user/.codex /home/user/.codex-web/runtime /home/user/.codex-web/credentials/current /home/user/.meegle /home/user/.kube/cache \
  && touch /home/user/.codex/AGENTS.md \
  && ln -s /home/user/.codex-web/credentials/current/meegle/config.json /home/user/.meegle/config.json \
  && chown -R user:user /home/user/workspace /home/user/.codex /home/user/.codex-web /home/user/.meegle /home/user/.kube

USER user
WORKDIR /home/user/workspace
ENV HOME=/home/user \
    CODEX_HOME=/home/user/.codex \
    GLAB_CONFIG_DIR=/home/user/.codex-web/credentials/current/glab \
    MYSQL_TEST_LOGIN_FILE=/home/user/.codex-web/credentials/current/.mylogin.cnf \
    KUBECONFIG=/home/user/.codex-web/credentials/current/kubernetes/config.json \
    LARKSUITE_CLI_CONFIG_DIR=/home/user/.codex-web/credentials/current/lark-config \
    LARKSUITE_CLI_DATA_DIR=/home/user/.codex-web/credentials/current/lark-data \
    LARKSUITE_CLI_DEFAULT_AS=bot \
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 \
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 \
    GIT_TERMINAL_PROMPT=0 \
    MISE_DATA_DIR=/home/user/.local/share/mise \
    MISE_CONFIG_DIR=/home/user/.config/mise \
    MISE_STATE_DIR=/home/user/.local/state/mise \
    MISE_TRUSTED_CONFIG_PATHS=/home/user/workspace \
    PATH=/home/user/.local/share/mise/shims:/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
USER root
RUN chown user:user /home/user
USER user
RUN git config --global --add include.path /home/user/.codex-web/credentials/current/gitconfig

# sandbox-proxy: lightweight HTTP reverse proxy for exposing localhost-bound
# services through the container's Docker network interface.
COPY docker/sandbox/sandbox-proxy/main.go /tmp/sandbox-proxy/main.go
USER root
RUN mise exec go@1.25 -- go build -C /tmp/sandbox-proxy -o sandbox-proxy main.go \
  && cp /tmp/sandbox-proxy/sandbox-proxy /usr/local/bin/sandbox-proxy \
  && rm -rf /tmp/sandbox-proxy
USER user

# A project Sandbox owns one long-lived App Server and a localhost→0.0.0.0 proxy.
# Web connects over their Docker-internal WebSocket / HTTP; individual turns
# never start a worker process.
CMD ["node", "-e", "const {spawn}=require('node:child_process'); spawn('/usr/local/bin/sandbox-proxy',[],{stdio:'inherit',detached:true}).unref(); const extra=JSON.parse(process.env.CODEX_APP_SERVER_ARGS||'[]'); const child=spawn('codex',['app-server',...extra,'--listen',`ws://0.0.0.0:${process.env.CODEX_APP_SERVER_PORT}`, '--ws-auth','capability-token','--ws-token-file','/home/user/.codex-web/app-server-token'],{stdio:'inherit'}); child.on('exit',(code,signal)=>process.exit(code??(signal?1:0))); process.on('SIGTERM',()=>child.kill('SIGTERM')); process.on('SIGINT',()=>child.kill('SIGINT')); "]
