# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build .
# This is the controller only. Native Codex and development tools run in E2B.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true
RUN npm install --global pnpm@10.33.4
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN --mount=type=cache,id=swarm-hive-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY src ./src
COPY web ./web
RUN pnpm exec tsc --outDir dist/server && pnpm web:build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    AGENT_SERVER_HOST=0.0.0.0 \
    AGENT_SERVER_PORT=3000 \
    AGENT_WEB_ROOT=/app/dist/web \
    NATIVE_DATA_DIR=/app/data/native
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/dist/web ./dist/web
COPY --chown=node:node src/native/sdk-host.mjs ./dist/server/src/native/sdk-host.mjs
RUN mkdir -p /app/data/native && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/server/src/server/main.js"]
