import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { AppServerReader } from './app-server-reader.js';

test('real Codex readiness probes reuse the initialized transport without model calls', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cocell-readiness-'));
  const reservation = createServer();
  await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>(done => reservation.close(() => done()));
  const url = `ws://127.0.0.1:${address.port}`;
  const stopped = new AbortController();
  const server = spawn(resolve('node_modules/.bin/codex'), ['app-server', '--listen', url], {
    cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'ignore', 'ignore'],
  });
  server.on('error', error => stopped.abort(error));
  server.on('exit', () => stopped.abort(new Error('Codex App Server exited')));
  let endpoints = 0;
  const reader = new AppServerReader(async () => { endpoints++; return { url }; }, error => { throw error; });
  try {
    await reader.waitUntilReady('local-test', stopped.signal, 10_000);
    const opened = endpoints;
    await reader.waitUntilReady('local-test', stopped.signal, 10_000);
    const threads = await reader.read('local-test', client => client.request('thread/loaded/list', {}), stopped.signal);
    assert.deepEqual(threads.data, []);
    assert.equal(endpoints, opened, 'verification and first use reuse one connection');
  } finally {
    try { await reader.close(); }
    finally {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        const kill = setTimeout(() => server.kill('SIGKILL'), 2_000);
        server.kill('SIGTERM');
        try { await exited; } finally { clearTimeout(kill); }
      }
      await rm(home, { recursive: true, force: true });
    }
  }
});
