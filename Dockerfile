FROM node:22.18.0-bookworm-slim

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ARG DOCKER_CLI_VERSION=29.1.3
ARG RESTIC_VERSION=0.18.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar bzip2 sqlite3 \
  && curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" \
    | tar -xz -C /tmp \
  && install -m 0755 "/tmp/docker/docker" /usr/local/bin/docker \
  && curl -fsSL "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_amd64.bz2" -o /tmp/restic.bz2 \
  && curl -fsSL "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/SHA256SUMS" -o /tmp/restic-SHA256SUMS \
  && grep " restic_${RESTIC_VERSION}_linux_amd64.bz2$" /tmp/restic-SHA256SUMS | sed "s#restic_${RESTIC_VERSION}_linux_amd64.bz2#/tmp/restic.bz2#" | sha256sum -c - \
  && bunzip2 /tmp/restic.bz2 && install -m 0755 /tmp/restic /usr/local/bin/restic \
  && rm -rf /tmp/docker /tmp/restic /tmp/restic-SHA256SUMS /var/lib/apt/lists/* \
  && corepack enable
RUN npm install --global @lark-project/meegle@1.0.20

# Fetch registry packages from the lockfile before copying application source.
# The persistent BuildKit store makes repeated builds work offline when neither
# package.json nor pnpm-lock.yaml changes. Local file dependencies are copied
# in the next layer because pnpm packages their source into node_modules.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=swarm-hive-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm fetch --frozen-lockfile

COPY packages ./packages
RUN --mount=type=cache,id=swarm-hive-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm install --offline --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["pnpm", "start"]
