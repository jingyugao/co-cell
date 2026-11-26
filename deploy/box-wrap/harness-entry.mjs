// This entry ships inside an immutable harness release alongside its native tools.
import { installReleaseShell } from './release-shell.mjs';
import { attachReleaseSkills } from './release-skills.mjs';
import { readlink, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startLauncher } from './launcher.mjs';
import { startAcpHost } from './acp/host.mjs';

const native = path => fileURLToPath(new URL(path, import.meta.url));
const shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());
process.once('SIGINT', () => shutdown.abort());
// A previously configured Box can restart its Harness before the next project lifecycle hook.
const selected = await readlink('/home/agent/workspace/.cocell/agent-assets').catch(error => {
  if (error.code !== 'ENOENT' && error.code !== 'EINVAL') throw error;
});
const assets = selected && /^\/var\/lib\/cellbox\/shared\/agents\/versions\/[0-9a-f]{64}\/assets$/.test(selected)
  && (await stat(selected).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.isDirectory()
  ? selected : native('./assets');
await installReleaseShell('/home/agent', native('.').replace(/\/$/, ''));
await attachReleaseSkills(assets, '/home/agent');
process.exitCode = await startLauncher({
  assets,
  signal: shutdown.signal,
  codex: native('./codex/bin/codex'),
  acpHost: options => startAcpHost({ ...options, command: native('./claude/claude-agent-acp') }),
});
