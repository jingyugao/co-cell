FROM node:22.18.0-bookworm-slim

# This is the disposable project runtime, not the web application image. The
# host deliberately mounts Docker's socket into the web service and creates a
# fresh container from this image for every project sandbox.
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
  && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
    bash ca-certificates curl git openssh-client python3 python3-venv \
    make g++ procps rsync tar gzip unzip \
  && rm -rf /var/lib/apt/lists/* \
  && if getent passwd 1000 >/dev/null; then existing_user="$(getent passwd 1000 | cut -d: -f1)"; if [ "$existing_user" != user ]; then usermod -l user "$existing_user"; fi; else useradd --uid 1000 --create-home --shell /bin/bash user; fi \
  && if getent group 1000 >/dev/null; then existing_group="$(getent group 1000 | cut -d: -f1)"; if [ "$existing_group" != user ]; then groupmod -n user "$existing_group"; fi; else groupadd --gid 1000 user; fi \
  && usermod -g user user \
  && corepack enable \
  && npm install --global @openai/codex@0.153.4

# Public command-line tools are part of the immutable Sandbox image. Credentials
# are mounted separately at runtime and never enter an image layer.
COPY scripts/sandbox/install-command-tools.sh /usr/local/sbin/install-command-tools
RUN bash /usr/local/sbin/install-command-tools \
  && rm /usr/local/sbin/install-command-tools \
  && mkdir -p /home/user/workspace /home/user/.codex /home/user/.codex-web/runtime /home/user/.meegle /home/user/.kube/cache \
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
    PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
USER root
RUN chown user:user /home/user
USER user
RUN git config --global --add include.path /home/user/.codex-web/credentials/current/gitconfig

# A project Sandbox owns one long-lived App Server. Web connects over its
# Docker-internal WebSocket; individual turns never start a worker process.
CMD ["node", "-e", "const {spawn}=require('node:child_process'); const extra=JSON.parse(process.env.CODEX_APP_SERVER_ARGS||'[]'); const child=spawn('codex',['app-server',...extra,'--listen',`ws://0.0.0.0:${process.env.CODEX_APP_SERVER_PORT}`, '--ws-auth','capability-token','--ws-token-file','/home/user/.codex-web/app-server-token'],{stdio:'inherit'}); child.on('exit',(code,signal)=>process.exit(code??(signal?1:0))); process.on('SIGTERM',()=>child.kill('SIGTERM')); process.on('SIGINT',()=>child.kill('SIGINT')); "]
