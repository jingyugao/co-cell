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

```sh
make deploy-cellbox-api CELLBOX_SOURCE_DIR=../cell-box COCELL_REGISTRY_ENDPOINT=http://REGISTRY_HOST:PORT
make deploy-cellbox-controller CELLBOX_SOURCE_DIR=../cell-box COCELL_REGISTRY_ENDPOINT=http://REGISTRY_HOST:PORT
make deploy-co-cell COCELL_REGISTRY_ENDPOINT=http://REGISTRY_HOST:PORT
make deploy-all CELLBOX_SOURCE_DIR=../cell-box COCELL_REGISTRY_ENDPOINT=http://REGISTRY_HOST:PORT
make deploy-debug-mount CELLBOX_SOURCE_DIR=../cell-box COCELL_REGISTRY_ENDPOINT=http://REGISTRY_HOST:PORT COCELL_DEBUG_READ_ONLY_HOST_PATH=/ABSOLUTE/NODE/DIRECTORY COCELL_SANDBOX_IMAGE_TAG=v0.0.2
```

`deploy-cellbox-controller` updates the ResumablePod CRD and controller image.
`deploy-cellbox-api` builds and publishes the Cellbox API image, checks for
active operations, updates its `Recreate` deployment, and verifies the running
Pod uses the published digest. `deploy-co-cell` deploys only the CoCell web
service. `deploy-debug-mount` builds Cellbox once and runs the controller, API,
and Sandbox deployments in sequence. `deploy-all` also deploys the CoCell web
service. With the debug host mount, remove `__mysqlLogin` and
`__kubernetes_config.json` from CoCell's credential-slot mapping; their CLI
wrappers read those files from the mount. Keep registry addresses and
credentials in local configuration, not
in this file. Do not apply Cellbox's example `deploy/cellbox-api.yaml` to the
CoCell installation.
