# Kubernetes credentials

Kubernetes access is opt-in. Set `COCELL_KUBECONFIG` to an absolute path of a
dedicated, least-privileged kubeconfig, then run `pnpm credentials:import`.
CoCell validates and imports the file but does not create Kubernetes resources,
issue tokens, renew credentials, or inspect a user's default kubeconfig.

Treat the referenced file as a secret: keep it outside the repository, grant
only the namespaces and verbs required for the intended tasks, and rotate or
revoke it through the cluster's normal access-management process. Imported
credentials are distributed only to Sandbox sessions that require them.
