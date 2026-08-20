FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.8.15 /uv /uvx /usr/local/bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /bin/bash agent

ARG TARGETARCH
ARG GLAB_VERSION=1.114.0

RUN case "$TARGETARCH" in \
      amd64|arm64) glab_arch="$TARGETARCH" ;; \
      *) echo "Unsupported glab architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL \
      "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${glab_arch}.tar.gz" \
      -o /tmp/glab.tar.gz \
    && tar -xzf /tmp/glab.tar.gz -C /tmp \
    && install -m 0755 /tmp/bin/glab /usr/local/bin/glab \
    && rm -rf /tmp/glab.tar.gz /tmp/bin

COPY bin/apply_patch /usr/local/bin/apply_patch
COPY bin/git-askpass /usr/local/bin/git-askpass
COPY bin/gitlab-init /usr/local/bin/gitlab-init
RUN chmod 0755 \
      /usr/local/bin/apply_patch \
      /usr/local/bin/git-askpass \
      /usr/local/bin/gitlab-init

WORKDIR /workspace/repo
