import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { loadDeployEnv } from '../config/deploy-env.mjs';
import { liveTransport } from './support/kubernetes.mjs';

loadDeployEnv();

const profiles = {
  ui: ['harness', 'ui-desktop', 'ui-mobile'],
  live: ['live'],
  full: ['harness', 'ui-desktop', 'ui-mobile', 'live', 'model'],
  reads: ['model'],
  lifecycle: ['model'],
  'user-input': ['model'],
  agent: ['model'],
  core: ['live', 'model'],
  extended: ['live', 'model'],
};
const [profile = 'ui', ...args] = process.argv.slice(2);
if (profile === '--help' || profile === 'help') {
  console.log(`CoCell integration tests

pnpm test:integration                   Local browser regression; no cluster or model
pnpm test:integration:live              Deployed API + browser; creates isolated projects
pnpm test:integration:full              All suites, including real model turns
pnpm test:integration:reads             Real conversation history and nested subagents
pnpm test:integration:lifecycle         Real files, process continuity, backup/restore
pnpm test:integration:user-input        Real asynchronous user question and answer
pnpm test:integration:agent             Real agent writes files and starts HTTP; no tool credentials
pnpm test:integration:core              Real core API/browser/model journeys; no business tool cases
pnpm test:integration:extended          Core plus subagents, Git/Go and disposable-CI Web restart
pnpm test:integration:full --list        List coverage without connecting to services

Live suites require COCELL_E2E_BASE_URL and COCELL_E2E_ACCESS_TOKEN.
Alternatively, set COCELL_E2E_KUBE_CONTEXT in ignored deploy.env to use the existing Helm release.
COCELL_E2E_PUBLIC_URL optionally supplies the public Host/Origin when using a port-forward.
Install Chromium once: pnpm exec playwright install chromium
Reports: tmp/integration/<run>/ (HTML, JSON, JUnit, per-test evidence and cleanup journal).
COCELL_E2E_KEEP_PROJECT=1 explicitly retains test resources for diagnosis.
Resume cleanup after interruption: pnpm test:integration:cleanup path/to/resources.json
All other runs clean up their own projects, including on failure. Model suites use real tokens.`);
} else {
  if (!profiles[profile]) throw new Error(`Unknown integration profile: ${profile}; use --help`);
  const output = resolve(process.env.COCELL_E2E_OUTPUT_DIR ?? `tmp/integration/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const require = createRequire(import.meta.url);
  // A free loopback port avoids collisions with local developer services.
  if (['ui', 'full'].includes(profile) && !process.env.COCELL_E2E_UI_PORT) {
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    process.env.COCELL_E2E_UI_PORT = String(probe.address().port);
    await new Promise(resolve => probe.close(resolve));
  }
  const transport = profile !== 'ui' && !args.includes('--list') ? await liveTransport(process.env) : { env: {}, close() {} };
  const child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test',
    '--config=scripts/integration/playwright.config.mjs',
    ...(args.some(arg => arg === '--project' || arg.startsWith('--project=')) ? [] : profiles[profile].map(name => `--project=${name}`)),
    ...(profile === 'reads' ? ['--grep=conversation reads'] : []),
    ...(profile === 'lifecycle' ? ['--grep=project lifecycle'] : []),
    ...(profile === 'user-input' ? ['--grep=asynchronous user input'] : []),
    ...(profile === 'agent' ? ['--grep=real agent creates files'] : []),
    ...(['core', 'extended'].includes(profile) ? [`--grep-invert=prepared image tools|native .* HOME|deployed Git proxy${profile === 'core' ? '|conversation reads|nightly:' : ''}`] : []),
    ...args], { stdio: 'inherit', env: { ...process.env, ...transport.env, COCELL_E2E_PROFILE: profile, COCELL_E2E_OUTPUT_DIR: output } });
  // Let Playwright tear down fixtures on the first interrupt.
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', async error => { await transport.close(); console.error(error.message); process.exitCode = 1; });
  child.on('exit', async (code, signal) => { await transport.close(); console.log(`Integration reports: ${output}`); process.exitCode = code ?? (signal ? 130 : 1); });
}
