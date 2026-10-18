# CoCell contributor guide

CoCell is a TypeScript, Node.js, Hono, React, and Vite web workspace for
running coding agents in project-scoped Docker Sandboxes.

swarm-hive is the old name of this project. Use CoCell now.
## Development

Use Node.js 22.18 or later and pnpm. Install dependencies with
`pnpm install --frozen-lockfile`; validate changes with `pnpm typecheck` and
`pnpm build`. Start development with `PORT=3001 pnpm dev`.

The maintained integration module is `scripts/integration/`. Keep core project,
Sandbox, conversation, and user-input behavior covered in the same change that
modifies it. Run `pnpm test:integration` for local desktop/mobile regressions.
Use `pnpm test:integration:live` against the configured test installation for
runtime changes, and `pnpm test:integration:full` for real model, files, process
continuity, backup/restore, and conversation-history verification. Model suites
consume real model tokens. Do not replace live assertions with mocks or add
unconditional retries to hide failures. Run instructions and the coverage map
are in [the integration guide](tmp/docs/integration-tests.md).

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

## Deployment

Run deployments from this repository's root. The Cellbox source is in the
sibling `cell-box` repository. Set `COCELL_REGISTRY_ENDPOINT` to the HTTP
registry origin used by the installation.

Keep local installation settings in root `deploy.env`, using
`deploy.env.example` as the template. All `make deploy-*` targets and integration
commands load it; explicit environment variables take precedence. `deploy.env`
is excluded from Git and Docker build contexts. Integration tests can read the
existing Kubernetes Secret in memory using `COCELL_E2E_KUBE_CONTEXT`, so operator
tokens need not be copied into the file.

The server uses exactly one of `CELLBOX_TEMPLATE_ID` or `CELLBOX_REVISION_ID`;
`CELLBOX_PROFILE` selects the runtime specification. Configure the dedicated
server node and persistent storage before deployment. A legacy installation
requires a new data directory and object-storage prefix; existing v2 upgrades
preserve their storage. Legacy metadata and archive indexes are not imported.

`make deploy-cellbox-server` builds and publishes one server image, checks
active Box operations, deploys the single-node `cellbox-server`, and verifies
its image digest. `make deploy-cocell-sandbox` submits one explicit template
revision build and prints its selector. Save that revision for standalone
`make deploy-co-cell`. `make deploy-all` passes the newly built revision to
CoCell automatically; any unconfirmed build result stops the sequence.
`make deploy-debug-mount` updates the server and Sandbox only.

The old `deploy-cellbox-api`, `deploy-cellbox-controller`, and
`deploy-cellbox-local-metadata` targets reject execution. Use the sibling
Cellbox single-server chart; do not apply an old example API Deployment.
Keep installation addresses, credentials, storage paths, and selectors in
local configuration. See the [migration plan](tmp/docs/cellbox-migration-plan-2026-10-18.md)
for data boundaries and validation before any operator-authorized rollout.
