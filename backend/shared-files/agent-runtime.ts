import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import type { SandboxHandle } from '@co-cell/sandbox';
import { AgentProfiles, assetFiles } from './agent-profiles.js';

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const script = readFile(new URL('./apply-agent.cjs', import.meta.url), 'utf8');
const shared = '/var/lib/cellbox/shared';
const workspace = '/home/agent/workspace';
export function guestNode(boxId: string, fallback: string) {
  // Prepared images provide Node directly. Bare images get it from the selected release.
  const harness = shared + '/harness';
  return `node_bin=${quote(fallback)}; if [ ! -x "$node_bin" ]; then rev=$(cat ${quote(harness + '/boxes/' + boxId)} 2>/dev/null || cat ${quote(harness + '/current')}) && node_bin=${quote(harness + '/versions/')}"$rev/bin/node"; fi; "$node_bin"`;
}

interface BoxAgent {
  projectId: string;
  agentId: string;
  revision: string;
  refreshedCodexCwd?: string;
}

export class AgentRuntime {
  constructor(
    private profiles: AgentProfiles,
    private projectAgent: (projectId: string) => Promise<string>,
    private node: string,
    private reloadCodexSkills: (boxId: string, cwd: string, signal: AbortSignal) => Promise<void>,
  ) {}
  private pin(boxId: string) {
    if (!/^[\w-]{1,128}$/.test(boxId)) throw Error('Invalid Box ID');
    return join(this.profiles.root, 'boxes', boxId + '.json');
  }
  private async selection(boxId: string): Promise<BoxAgent | null> {
    return JSON.parse(
      await readFile(this.pin(boxId), 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return 'null';
        throw e;
      }),
    );
  }
  private async saveSelection(pin: string, selection: BoxAgent) {
    await mkdir(posix.dirname(pin), { recursive: true });
    const next = pin + '.' + randomUUID();
    try {
      await writeFile(next, JSON.stringify(selection), { flag: 'wx' });
      await rename(next, pin);
    } finally {
      await rm(next, { force: true });
    }
  }
  async forget(boxId: string) {
    await this.profiles.lock('box:' + boxId, () => rm(this.pin(boxId), { force: true }));
  }
  async boundProject(boxId: string) {
    return (await this.selection(boxId))?.projectId;
  }
  async apply(
    handle: SandboxHandle,
    projectId: string,
    mounted: boolean,
    latest: boolean,
    signal: AbortSignal,
    codexCwd?: string,
  ) {
    const id = handle.sandboxId;
    return this.profiles.lock('box:' + id, async () => {
      const agentId = await this.projectAgent(projectId);
      const pin = this.pin(id),
        previous = await this.selection(id);
      const revision: string =
        !latest && previous?.agentId === agentId && previous.projectId === projectId
          ? previous.revision
          : (await this.profiles.get(agentId)).revision;
      const local = this.profiles.assets(revision);
      const remote = mounted
        ? shared + '/agents/versions/' + revision + '/assets'
        : workspace + '/.cocell/agent-versions/' + revision + '/assets';
      const run = async (command: string) => {
        const result = await handle.commands.run(command, { user: 'agent', timeoutMs: 30_000, signal });
        if (result.exitCode !== 0) throw Error('无法应用 Agent 配置：' + result.stderr.slice(-400));
      };
      if (!mounted) {
        const staged = posix.dirname(remote) + '.' + randomUUID();
        const done = await handle.commands.run('if test -d ' + quote(remote) + '; then echo ready; fi', {
          user: 'agent',
          signal,
          timeoutMs: 5000,
        });
        if (done.stdout.trim() !== 'ready') {
          try {
            await run('mkdir -p ' + quote(staged + '/assets/docs') + ' ' + quote(staged + '/assets/skills'));
            for (const f of await assetFiles(local)) {
              const dest = staged + '/assets/' + f.path;
              await run('mkdir -p ' + quote(posix.dirname(dest)));
              await handle.files.write(dest, Uint8Array.from(f.bytes).buffer, { user: 'agent', signal });
              if (f.executable) await run('chmod 755 ' + quote(dest));
            }
            await run('mv ' + quote(staged) + ' ' + quote(posix.dirname(remote)));
          } finally {
            await handle.commands.run('rm -rf ' + quote(staged), { user: 'agent', timeoutMs: 5000 }).catch(() => {});
          }
        }
      }
      await run(
        guestNode(id, this.node) +
          ' -e ' +
          quote(await script) +
          ' ' +
          [remote, workspace, '/home/agent'].map(quote).join(' '),
      );
      const changed =
        previous?.revision !== revision || previous?.agentId !== agentId || previous?.projectId !== projectId;
      const selection = { projectId, agentId, revision };
      if (changed) await this.saveSelection(pin, selection);
      // Native skills are cached per working directory across threads. Persist the acknowledgement
      // separately so a failed RPC can be retried without reverting an already installed version.
      if (codexCwd && (latest || changed || previous?.refreshedCodexCwd !== codexCwd)) {
        await this.reloadCodexSkills(id, codexCwd, signal);
        await this.saveSelection(pin, { ...selection, refreshedCodexCwd: codexCwd });
      }
      return revision;
    });
  }
}
