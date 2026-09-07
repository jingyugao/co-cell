import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Sandbox } from 'e2b';
import { E2BCodexRuntime } from '../server/e2b.js';
import type { Session, Turn } from '../shared/types.js';

const options = { connection: {}, template: 'base', timeoutMs: 1800000, apiKey: 'test-key' };
function session(id: string, projectId?: string): Session {
  return {
    id, projectId, title: id, threadId: null, status: 'idle', turns: [], createdAt: '', updatedAt: '',
    settings: { executionMode: 'e2b', workingDirectory: '/home/user/workspace', model: '', modelReasoningEffort: 'medium', sandboxMode: 'workspace-write', webSearchMode: 'disabled', networkAccessEnabled: true },
    sandbox: { id: projectId ? `vm-${projectId}` : `vm-session-${id}`, status: 'paused', template: 'base', workingDirectory: '/home/user/workspace' },
  };
}
const turn: Turn = { id: 'turn', prompt: 'test', images: [], status: 'running', items: [], startedAt: '' };

test('default activation affects subsequent creates without relabelling an in-flight sandbox', async t => {
  const runtime = new E2BCodexRuntime({ ...options });
  t.after(() => runtime.close());
  const created: string[] = [];
  t.mock.method(Sandbox, 'create', async (template: string) => {
    created.push(template);
    runtime.setDefaultTemplate('verified-next');
    await new Promise(resolve => setImmediate(resolve));
    return {
      sandboxId: `vm-${created.length}`, setTimeout: async () => {}, pause: async () => {},
      files: { exists: async () => true, remove: async () => {}, write: async () => {} },
      commands: { run: async (_command: string, opts?: { background?: boolean; onStdout?: (value: string) => void }) => {
        if (!opts?.background) return { stdout: '' };
        opts.onStdout?.('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0,"cached_input_tokens":0}}\n');
        return { wait: async () => ({ stdout: '' }), kill: async () => true };
      } },
    };
  });
  const recorded: string[] = [];
  for (const id of ['first', 'second']) {
    const value = { ...session(id, id), sandbox: undefined };
    for await (const _event of runtime.run(value, turn, new AbortController().signal, async sandbox => { recorded.push(sandbox.template); })) { /* drain */ }
    if (id === 'first') assert.ok(recorded.every(template => template === 'base'));
  }
  assert.deepEqual(created, ['base', 'verified-next']);
  assert.equal(recorded.at(-1), 'verified-next');
});

test('every project turn syncs shared global guidance before starting Codex, including resumed threads', async t => {
  const base = fileURLToPath(new URL('../data/.tests/', import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'e2b-shared-docs-'));
  await mkdir(join(directory, 'docs'));
  let expected = 'Initial shared guidance: read ~/.codex/docs/README.md.';
  let expectedDoc: string | undefined = 'Initial documentation.';
  await writeFile(join(directory, 'AGENTS.md'), expected);
  await writeFile(join(directory, 'docs/README.md'), expectedDoc);
  const runtime = new E2BCodexRuntime({ ...options, sharedDataDirectory: pathToFileURL(`${directory}/`) });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const files = new Map<string, Map<string, string>>();
  const workers: { id: string; threadId: string | null; guidance: string }[] = [];
  t.mock.method(Sandbox, 'connect', async (id: string) => {
    const contents = new Map<string, string>([['/home/user/workspace/AGENTS.md', 'project-specific rules']]);
    files.set(id, contents);
    return {
      sandboxId: id, setTimeout: async () => {}, pause: async () => {},
      files: {
        exists: async () => true,
        remove: async (path: string) => { contents.delete(path); },
        write: async (path: string, value: string | ArrayBuffer) => { contents.set(path, typeof value === 'string' ? value : new TextDecoder().decode(value)); },
      },
      commands: { run: async (command: string, opts?: { background?: boolean; envs?: Record<string, string>; onStdout?: (value: string) => void }) => {
        if (!opts?.background) return { stdout: '' };
        if (command.includes('rm -rf') && command.includes('/home/user/.codex/docs')) {
          for (const path of contents.keys()) if (path.startsWith('/home/user/.codex/docs/')) contents.delete(path);
        }
        if (command.includes('e2b-worker.mjs')) {
          assert.equal(opts.envs?.CODEX_HOME, '/home/user/.codex');
          const guidance = contents.get(`${opts.envs.CODEX_HOME}/AGENTS.md`);
          assert.equal(guidance, expected, 'the worker must see the central version before it starts');
          assert.equal(contents.get('/home/user/.codex/docs/README.md'), expectedDoc, 'the worker must see the latest document snapshot');
          const input = [...contents].find(([path]) => /\/input-.*\.json$/.test(path));
          assert.ok(input);
          workers.push({ id, threadId: JSON.parse(input[1]).threadId, guidance });
          opts.onStdout?.(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + '\n');
        }
        return { wait: async () => ({ stdout: '' }), kill: async () => true };
      } },
    };
  });
  const run = async (value: Session) => {
    const events = [];
    for await (const event of runtime.run(value, turn, new AbortController().signal, async () => {})) events.push(event);
    assert.equal(events.at(-1)?.type, 'turn.completed');
  };
  await run(session('a', 'first'));
  expected = 'Updated shared guidance.';
  expectedDoc = 'Updated documentation.';
  await writeFile(join(directory, 'AGENTS.md'), expected);
  await writeFile(join(directory, 'docs/README.md'), expectedDoc);
  files.get('vm-first')!.set('/home/user/.codex/AGENTS.md', 'stale sandbox guidance');
  await run({ ...session('a', 'first'), threadId: 'existing-thread' });
  await run(session('b', 'second'));
  expected = '';
  expectedDoc = undefined;
  await rm(join(directory, 'AGENTS.md'));
  await rm(join(directory, 'docs/README.md'));
  await run({ ...session('a', 'first'), threadId: 'existing-thread' });
  assert.deepEqual(workers.map(({ id, threadId }) => ({ id, threadId })), [
    { id: 'vm-first', threadId: null }, { id: 'vm-first', threadId: 'existing-thread' }, { id: 'vm-second', threadId: null },
    { id: 'vm-first', threadId: 'existing-thread' },
  ]);
  for (const contents of files.values()) assert.equal(contents.get('/home/user/workspace/AGENTS.md'), 'project-specific rules');
});

test('sibling sessions reconnect once and inspect a shared workspace without having a Codex thread', async t => {
  let connects = 0, recoveries = 0, inspections = 0, pauses = 0;
  const runtime = new E2BCodexRuntime(options);
  t.after(() => runtime.close());
  t.mock.method(Sandbox, 'connect', async (id: string) => {
    connects++;
    await new Promise(resolve => setImmediate(resolve));
    return {
      sandboxId: id, files: { exists: async () => true }, pause: async () => { pauses++; },
      commands: { run: async (command: string) => {
        if (command.includes('e2b-inspect.mjs')) {
          inspections++;
          return { stdout: JSON.stringify({ branch: 'main', files: [{ path: 'shared.ts', status: 'M' }], diff: 'shared diff' }) };
        }
        recoveries++;
        return { stdout: '' };
      } },
    };
  });
  const [first, second] = await Promise.all([runtime.changes(session('a', 'project')), runtime.changes(session('b', 'project'))]);
  assert.equal(first.diff, 'shared diff');
  assert.deepEqual(first, second);
  assert.equal(connects, 1);
  assert.equal(recoveries, 1, 'opening another session must not reap the shared runtime again');
  assert.equal(inspections, 2);
  // A legacy session ID can equal a project ID without sharing its sandbox.
  await runtime.changes(session('project'));
  assert.equal(connects, 2);
  await runtime.close();
  assert.equal(pauses, 2);
});

test('project runtime rejects a concurrent sibling turn, preserves its worker and keeps raw logs session-specific', async t => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  let connects = 0, backgrounds = 0, kills = 0;
  const inspectCommands: string[] = [];
  const runtime = new E2BCodexRuntime(options);
  t.after(() => runtime.close());
  t.mock.method(Sandbox, 'connect', async (id: string) => {
    connects++;
    return {
      sandboxId: id, setTimeout: async () => {}, pause: async () => {},
      files: { exists: async () => true, remove: async () => {}, write: async () => {} },
      commands: { run: async (command: string, opts?: { background?: boolean }) => {
        if (opts?.background) {
          backgrounds++;
          started();
          return { wait: async () => { await gate; return { stdout: '' }; }, kill: async () => { kills++; return true; } };
        }
        if (command.includes('e2b-inspect.mjs')) {
          inspectCommands.push(command);
          return { stdout: JSON.stringify({ source: 'codex-rollout', threadId: 'thread-b', availability: 'available', messages: [], nextCursor: 0, hasMore: false, skippedLines: 0 }) };
        }
        return { stdout: '' };
      } },
    };
  });
  const abort = new AbortController();
  const first = runtime.run(session('a', 'shared'), turn, abort.signal, async () => {});
  const completion = first.next();
  await running;
  const sibling = { ...session('b', 'shared'), threadId: 'thread-b' };
  await assert.rejects(runtime.run(sibling, turn, new AbortController().signal, async () => {}).next(), /另一个会话正在运行/);
  assert.equal(backgrounds, 1);
  assert.equal(kills, 0, 'rejecting a sibling must not terminate the active worker');
  await assert.rejects(runtime.delete(sibling), /请先停止/);
  const raw = await runtime.rawTools(sibling);
  assert.equal(raw.threadId, 'thread-b');
  assert.match(inspectCommands[0], /'raw' 'thread-b'/);
  assert.equal(connects, 1);
  abort.abort();
  release();
  await assert.rejects(completion, /任务已停止/);
  assert.equal(kills, 1);
});
