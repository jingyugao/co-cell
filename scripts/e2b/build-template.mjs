import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Template } from 'e2b';
import { templatePaths } from './options.mjs';

// Use the same local-only authenticated administration client as the E2B demo.
const { localConfig, requireHealthyApi } = await import(pathToFileURL(`${homedir()}/.data/e2b/client/config.mjs`).href);
const config = await localConfig();
await requireHealthyApi(config);
const paths = templatePaths();
const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
const alias = paths.alias ?? manifest.template;
// Local self-hosted builders may not support the SDK file-upload layer. These
// small, repository-owned files contain no secrets and can travel in RUN safely.
const encodedManifest = Buffer.from(JSON.stringify(manifest)).toString('base64');
const encodedInstaller = (await readFile(new URL('install-toolchains.sh', import.meta.url))).toString('base64');
const encodedProfile = (await readFile(new URL('profile.sh', import.meta.url))).toString('base64');
const encodedCommandTools = (await readFile(new URL('install-command-tools.sh', import.meta.url))).toString('base64');
const encodedPhp = (await readFile(new URL('install-php.sh', import.meta.url))).toString('base64');
const template = Template({ fileContextPath: fileURLToPath(new URL('./', import.meta.url)) })
  // Reusing the old base snapshot also inherits its small root disk. Starting
  // from OCI lets the builder provision the team's configured free disk space.
  .fromBaseImage()
  .runCmd(`mkdir -p /opt/codex-template && printf %s '${encodedManifest}' | base64 -d > /opt/codex-template/toolchains.json && printf %s '${encodedInstaller}' | base64 -d > /opt/codex-template/install-toolchains.sh && chmod 0755 /opt/codex-template/install-toolchains.sh`, { user: 'root' })
  .runCmd('bash /opt/codex-template/install-toolchains.sh root', { user: 'root' })
  .runCmd('bash /opt/codex-template/install-toolchains.sh', { user: 'user' })
  .runCmd(`printf %s '${encodedProfile}' | base64 -d > /etc/profile.d/codex-toolchains.sh && chmod 0644 /etc/profile.d/codex-toolchains.sh`, { user: 'root' })
  // Keep public CLI tools in a late layer so changes reuse language installations.
  .runCmd(`printf %s '${encodedCommandTools}' | base64 -d > /opt/codex-template/install-command-tools.sh && chmod 0755 /opt/codex-template/install-command-tools.sh && bash /opt/codex-template/install-command-tools.sh`, { user: 'root' })
  .runCmd(`printf %s '${encodedPhp}' | base64 -d > /opt/codex-template/install-php.sh && chmod 0755 /opt/codex-template/install-php.sh && bash /opt/codex-template/install-php.sh`, { user: 'root' })
  .setEnvs({
    PATH: '/home/user/.local/share/mise/shims:/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin',
    MISE_YES: '1',
  });
console.log(`Building ${alias}: Go ${manifest.go.join(', ')}, Node ${manifest.node.join(', ')}, Python ${manifest.python.join(', ')}`);
const result = await Template.build(template, alias, {
  ...config, cpuCount: manifest.cpuCount, memoryMB: manifest.memoryMB,
  onBuildLogs: entry => console.log(`${entry.timestamp.toISOString()} ${entry.level} ${entry.message.replace(/'[A-Za-z0-9+/=]{200,}'/g, "'[embedded template file]'")}`),
});
const output = paths.output;
await mkdir(output, { recursive: true });
await writeFile(join(output, 'template-build.json'), JSON.stringify({ ...result, manifest, builtAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify(result));
