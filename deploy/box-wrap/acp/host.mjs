import { mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startClaudeAcpHost } from './server.mjs';

export async function startAcpHost({ workspace, agentHome, sharedDirectory, port = 4501, signal, command = '/usr/local/bin/claude-agent-acp' }) {
  if (!workspace || !agentHome) throw new Error('Workspace and agent home are required');
  const productDirectory = join(resolve(workspace), '.cocell');
  const claudeHome = join(productDirectory, 'claude');
  await mkdir(claudeHome, { recursive: true, mode: 0o700 });
  for (const [name, target] of [['CLAUDE.md', join(productDirectory, 'codex', 'AGENTS.md')], ['docs', join(productDirectory, 'codex', 'docs')]]) {
    try { await symlink(target, join(claudeHome, name)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const runtime = await startClaudeAcpHost({ directory: join(resolve(workspace), '.cocell', 'claude-acp'), workspace, agentHome, sharedDirectory, port, command });
  const close = () => runtime.close();
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) await close();
  return { port: runtime.port, close };
}
