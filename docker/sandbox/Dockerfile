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

USER user
WORKDIR /home/user/workspace
ENV HOME=/home/user \
    CODEX_HOME=/home/user/.codex \
    PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
RUN mkdir -p /home/user/workspace /home/user/.codex /home/user/.codex-web/runtime

# Keep the container alive; every command and worker is launched via docker exec.
CMD ["sleep", "infinity"]
