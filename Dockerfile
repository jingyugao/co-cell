FROM docker:29-cli

RUN apk add --no-cache bash nodejs npm \
    && npm install --global pnpm@10.33.4

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY bin ./bin
COPY agent-specs ./agent-specs
COPY migrations ./migrations
COPY web ./web
RUN pnpm web:build

# The controller talks to the host daemon through a mounted Docker socket.
# Agent sandboxes themselves never receive that socket.
ENTRYPOINT ["pnpm", "exec", "tsx", "src/cli.ts"]
CMD ["server"]
