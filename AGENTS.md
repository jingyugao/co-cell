# CoCell contributor guide

CoCell is a TypeScript, Node.js, Hono, React, and Vite web workspace for
running coding agents in project-scoped Docker Sandboxes.

swarm-hive is the old name of this project. Use CoCell now.
## Development

Use Node.js 22.18 or later and pnpm. Install dependencies with
`pnpm install --frozen-lockfile`; validate changes with `pnpm typecheck` and
`pnpm build`. Start development with `PORT=3001 pnpm dev`.

Do not commit `.env`, `data/`, credentials, kubeconfigs, runtime logs, or
temporary investigation output. Use `.env.example` for documented, sanitized
configuration values. Kubernetes access is opt-in through
`COCELL_KUBECONFIG`; use a dedicated least-privileged credential.

## Architecture

The Hono backend owns projects, sessions, persistent metadata, and HTTP/SSE
routes. `packages/agentcore` connects to a persistent Codex App Server in a
project Sandbox. The React frontend renders sessions, events, project files,
and previews. Projects own Sandboxes; multiple sessions in one project share a
workspace while keeping independent conversation threads.

Keep route handling, business state, runtime integration, and UI concerns in
their respective modules. Update the `protocol/` contract with any API change,
and keep shared calculations in `util/`.

## Safety

Sandboxes may have access to source code and configured operator credentials.
Never hard-code secrets or organization-specific hosts, identities, paths, or
deployment details. Treat external changes such as deploying, merging,
publishing, modifying cluster resources, or writing production data as actions
that require explicit operator authorization.
