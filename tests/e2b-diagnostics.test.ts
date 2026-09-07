import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sandbox } from 'e2b';
import { E2BCodexRuntime } from '../server/e2b.js';
import { RuntimeLog } from '../server/runtime-log.js';
import type { Session, Turn } from '../shared/types.js';

test('E2B diagnostics persist with host correlation without entering SDK events or logging bodies', async t => {
  await mkdir('data/.tests', { recursive: true });
  const directory = await mkdtemp('data/.tests/e2b-diagnostics-');
  const logger = new RuntimeLog({ directory, secrets: ['private-key-for-test'] });
  const runtime = new E2BCodexRuntime({ connection: { apiKey: 'e2b-test-key' }, template: 'test', timeoutMs: 600000, apiKey: 'private-key-for-test', logger });
  t.after(async () => { await runtime.close(); await logger.flush(); await rm(directory, { recursive: true, force: true }); });
  t.mock.method(Sandbox, 'connect', async () => ({
    sandboxId: 'test-vm', setTimeout: async () => {}, pause: async () => {},
    files: { exists: async () => true, remove: async () => {}, write: async () => {} },
    commands: { run: async (_command: string, opts?: { background?: boolean; onStdout?: (text: string) => void }) => {
      if (!opts?.background) return { stdout: '' };
      if (_command.includes('e2b-worker.mjs')) {
        const diagnostic = JSON.stringify({ type: 'runtime.diagnostic', diagnostic: {
          event: 'api.error', requestId: 'request-1', httpStatus: 200, terminalEvent: 'response.failed',
          error: { code: 'server_overloaded', message: 'capacity private-key-for-test' },
          sessionId: 'untrusted-id', prompt: 'PRIVATE_PROMPT', requestBody: 'PRIVATE_BODY',
        } }) + '\n';
        opts.onStdout?.(diagnostic.slice(0, 30));
        opts.onStdout?.(diagnostic.slice(30) + JSON.stringify({ type: 'turn.failed', error: { message: 'capacity' } }) + '\n');
      }
      return { wait: async () => ({ stdout: '' }), kill: async () => true };
    } },
  }));
  const session: Session = { id: 'session-1', projectId: 'project-1', title: 'Private title', threadId: 'thread-1', status: 'running', turns: [], createdAt: '', updatedAt: '',
    settings: { executionMode: 'e2b', workingDirectory: '/home/user/workspace', model: 'gpt-5.6-sol', modelReasoningEffort: 'medium', sandboxMode: 'workspace-write', webSearchMode: 'disabled', networkAccessEnabled: true },
    sandbox: { id: 'test-vm', status: 'paused', template: 'test', workingDirectory: '/home/user/workspace' } };
  const turn: Turn = { id: 'turn-1', prompt: 'PRIVATE_PROMPT', images: [], status: 'running', items: [], startedAt: '' };
  const events = [];
  for await (const event of runtime.run(session, turn, new AbortController().signal, async () => {})) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['turn.failed']);
  await logger.flush();
  const text = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), 'utf8')))).join('');
  assert.ok(text.includes('server_overloaded'));
  for (const hidden of ['PRIVATE_PROMPT', 'PRIVATE_BODY', 'private-key-for-test', 'untrusted-id']) assert.ok(!text.includes(hidden));
  const record = JSON.parse(text.trim());
  assert.equal(record.sessionId, 'session-1'); assert.equal(record.turnId, 'turn-1'); assert.equal(record.sandboxId, 'test-vm');
  assert.equal(record.httpStatus, 200); assert.equal(record.requestId, 'request-1');
});
