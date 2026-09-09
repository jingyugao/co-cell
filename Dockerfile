FROM node:22.18.0-bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends socat \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["sh", "-c", "socat TCP-LISTEN:13000,fork,reuseaddr TCP:host.docker.internal:13000 & socat TCP-LISTEN:13002,fork,reuseaddr TCP:host.docker.internal:13002 & exec pnpm start"]
