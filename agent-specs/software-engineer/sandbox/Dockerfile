# syntax=docker/dockerfile:1
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.8.15 /uv /uvx /usr/local/bin/

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    sed -i \
      -e 's|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' \
      -e 's|http://deb.debian.org/debian-security|https://mirrors.aliyun.com/debian-security|g' \
      /etc/apt/sources.list.d/debian.sources \
    && rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      ripgrep \
    && useradd --uid 10001 --create-home --shell /bin/bash agent

COPY bin/apply_patch /usr/local/bin/apply_patch
RUN chmod 0755 /usr/local/bin/apply_patch \
    && mkdir -p /etc/swarm-hive

WORKDIR /workspace/repo
