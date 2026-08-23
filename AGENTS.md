# SwarmHive Repository Instructions

## Development environment

- Use `uv` to manage Python environments and dependencies.
- Put general Markdown documents under `./tmp/docs`. Repository-standard files such as `AGENTS.md` are exceptions.
- Use `pnpm check` for the standard TypeScript, web, and test validation suite.
- `agent-specs/` and `tmp/` contain private, local-only knowledge. Never add, commit, or push either directory.
- Never commit `.env`, kubeconfig files, tokens, passwords, private keys, or generated Agent workspaces.

## Doris

- Inspect Doris with `mysql --login-path=doris -e "SHOW DATABASES;"`.
- Trace Doris scheduled-job SQL in `<database>.sys_doris_insert_jobs_u` using `Name`, `Status`, `RecurringStrategy`, and `ExecuteSql`.
- Read SQL and DDL may be executed in the `example-tool-server` pod in the `example_data` context. Never execute data-update SQL.

## Kubernetes

- Available contexts are `example_data`, `common`, and `example_extra`; most services use `common`.
- Kubernetes access is read-only unless the user explicitly grants additional authority.
- Never create a temporary diagnostic pod.

## Git and delivery

- `uat` and `release` are shared deployment branches. Pushing merged code to them triggers UAT and staging deployment respectively.
- Never commit directly to `uat` or `release`.
- Never push commits to or merge code into `master`. Stop and wait for the user to perform protected-branch operations.
- If a change requires `proto-go`, modify `https://gitlab.example.com/golanglib/protos` and create an MR. The user will review it and generate the new `proto-go` library.
- Store service credentials in GitLab-managed secret settings, not in repository files.

## Agent runtime

- Stopping or restarting an Agent must preserve its workspace, code, and Git state unless the user explicitly requests cleanup.
- A restarted Agent Run uses a fresh conversation thread; old checkpoints may remain stored but must not be reused by the new Run.
