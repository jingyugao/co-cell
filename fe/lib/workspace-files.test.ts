import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkspaceFile } from './workspace-files';

test('text previews use bounded HTTP ranges and omit incomplete UTF-8 at the cutoff', async t => {
  const bytes = new Uint8Array(1024 * 1024).fill(97);
  bytes.set([0xe2, 0x82], bytes.length - 2);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.match(url, /\/files\/content\?path=/);
    calls.push(init.method ?? 'GET');
    if (init.method === 'HEAD') return new Response(null, { headers: { 'Content-Type': 'text/plain', 'Content-Length': '2097152' } });
    assert.equal(new Headers(init.headers).get('range'), 'bytes=0-1048575');
    return new Response(bytes, { status: 206, headers: { 'Content-Range': 'bytes 0-1048575/2097152' } });
  });
  const result = await loadWorkspaceFile('project', '/workspace/large.txt', new AbortController().signal);
  assert.deepEqual(calls, ['HEAD', 'GET']);
  assert.equal(result.kind, 'text'); assert.equal(result.truncated, true);
  assert.equal(result.text?.length, bytes.length - 2);
  assert.equal(result.size, 2097152);
});

test('empty text previews use a full GET without an unsatisfiable range', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('range'), null);
    return new Response(init.method === 'HEAD' ? null : '', { headers: { 'Content-Type': 'text/plain', 'Content-Length': '0' } });
  });
  const result = await loadWorkspaceFile('project', '/workspace/empty.txt', new AbortController().signal);
  assert.equal(result.kind, 'text'); assert.equal(result.text, ''); assert.equal(result.truncated, false);
});
