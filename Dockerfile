FROM node:22.18.0-bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates socat \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
RUN npm install --global @lark-project/meegle@1.0.20
COPY package.json pnpm-lock.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["sh", "-c", "socat TCP-LISTEN:13000,fork,reuseaddr TCP:host.docker.internal:13000 & socat TCP-LISTEN:13002,fork,reuseaddr TCP:host.docker.internal:13002 & exec pnpm start"]
