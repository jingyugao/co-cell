// This entry ships inside an immutable harness release alongside its native tools.
import { installReleaseShell } from './release-shell.mjs';
import { attachReleaseSkills } from './release-skills.mjs';
import { fileURLToPath } from 'node:url';
import { startLauncher } from './launcher.mjs';
import { startAcpHost } from './acp/host.mjs';

const native = path => fileURLToPath(new URL(path, import.meta.url));
const shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());
process.once('SIGINT', () => shutdown.abort());
const assets = native('./assets');
await installReleaseShell('/home/agent', native('.').replace(/\/$/, ''));
await attachReleaseSkills(assets, '/home/agent');
process.exitCode = await startLauncher({
  assets,
  signal: shutdown.signal,
  codex: native('./codex/bin/codex'),
  acpHost: options => startAcpHost({ ...options, command: native('./claude/claude-agent-acp') }),
});
