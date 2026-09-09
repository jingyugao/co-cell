FROM node:22.18.0-bookworm-slim

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["pnpm", "start"]
