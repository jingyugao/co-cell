FROM node:22.18.0-bookworm-slim

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates docker.io \
  && rm -rf /var/lib/apt/lists/* \
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
