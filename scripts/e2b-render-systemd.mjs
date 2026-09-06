import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
if (!/^\/[a-zA-Z0-9_./-]+$/.test(root)) throw new Error('安装路径含未支持的 systemd 特殊字符');
const data = `${root}/data/e2b`;
const out = `${root}/deploy/e2b/systemd`;
mkdirSync(out, { recursive: true });
for (const [name, bin, config, args] of [
  ['api', 'api', 'api', ' --port 13000'],
  ['proxy', 'client-proxy', 'client-proxy', ''],
]) {
  writeFileSync(`${out}/e2b-${name}.service`, `[Unit]
Description=E2B ${name} (local development)
PartOf=e2b.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${data}
EnvironmentFile=${data}/config/${config}.env
ExecStartPre=/bin/bash ${root}/scripts/e2b-wait-dependencies.sh ${name}
ExecStart=${data}/bin/${bin}${args}
Restart=on-failure
RestartSec=10
TimeoutStartSec=180
TimeoutStopSec=90
KillMode=mixed
UMask=0077

[Install]
WantedBy=e2b.target
`);
}
writeFileSync(`${out}/e2b.target`, `[Unit]
Description=E2B user services (API and proxy)
Wants=e2b-api.service e2b-proxy.service

[Install]
WantedBy=default.target
`);
writeFileSync(`${out}/e2b-orchestrator.service`, `[Unit]
Description=E2B privileged sandbox orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${data}
EnvironmentFile=${data}/config/orchestrator.env
ExecStartPre=/bin/bash ${root}/scripts/e2b-host-preflight.sh
ExecStartPre=/bin/bash ${root}/scripts/e2b-wait-dependencies.sh orchestrator
ExecStart=/usr/bin/env DISABLE_STARTUP_RECLAIM=true FORCE_STOP=false ${data}/bin/orchestrator
Restart=no
TimeoutStartSec=infinity
TimeoutStopSec=infinity
KillMode=mixed
Delegate=yes
UMask=0077

[Install]
WantedBy=multi-user.target
`);
console.log('systemd units rendered to deploy/e2b/systemd');
