FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e
USER root

# A user-supplied source image: Cellbox and CoCell add their agents on import.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global @openai/codex@0.156.1 \
  && npm cache clean --force \
  && test "$(codex --version)" = "codex-cli 0.156.1"

RUN curl --fail --silent --show-error --location --retry 3 \
    https://go.dev/dl/go1.25.1.linux-amd64.tar.gz -o /tmp/go.tar.gz \
  && echo '7716a0d940a0f6ae8e1f3b3f4f36299dc53e31b16840dbd171254312c41ca12e  /tmp/go.tar.gz' | sha256sum --check \
  && tar -C /usr/local -xzf /tmp/go.tar.gz \
  && rm /tmp/go.tar.gz \
  && /usr/local/go/bin/go version

ENV PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /home/agent/workspace
COPY main.go /opt/cocell-demo/main.go

ARG DEMO_VERSION=v1.0.0
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${DEMO_VERSION}" \
      -o /usr/local/bin/cocell-demo-http /opt/cocell-demo/main.go \
  && printf '%s\n' "$DEMO_VERSION" > /opt/cocell-demo/version.txt

LABEL org.opencontainers.image.title="CoCell demo development environment" \
      org.opencontainers.image.version="${DEMO_VERSION}"
EXPOSE 8080
CMD ["cocell-demo-http", "-port", "8080"]
