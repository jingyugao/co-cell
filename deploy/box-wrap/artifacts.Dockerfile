FROM scratch
ARG CODEX_VERSION
LABEL org.opencontainers.image.title="CoCell installation artifacts" \
      org.opencontainers.image.version="${CODEX_VERSION}"
COPY hindsight-coding-agents.tgz codex.tgz codex-linux-x64.tgz claude-agent-acp-linux-x64.tar.gz manifest.json SHA256SUMS /artifacts/
