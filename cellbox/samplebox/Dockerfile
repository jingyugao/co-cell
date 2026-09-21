FROM node:22.18.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @openai/codex@0.153.4

RUN useradd --uid 1000 --create-home --shell /bin/sh user \
  && mkdir -p /home/user/workspace /home/user/.codex /home/user/.codex-web \
  && chown -R user:user /home/user

USER user
WORKDIR /home/user/workspace
ENV HOME=/home/user CODEX_HOME=/home/user/.codex
