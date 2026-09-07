import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('E2B worker sends explicit full-access options through the real SDK for new and resumed legacy settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-e2b-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, 'fake-codex');
  const capture = join(directory, 'arguments.json');
  await writeFile(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0,cached_input_tokens:0}})));`, { mode: 0o700 });
  const packageDirectory = join(directory, 'node_modules/@openai/codex-sdk');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
  // Preserve the real SDK option serialization, replacing only its executable
  // with a local recorder; no Codex model request or E2B connection occurs.
  await writeFile(join(packageDirectory, 'index.js'), `import {Codex as RealCodex} from ${JSON.stringify(import.meta.resolve('@openai/codex-sdk'))};export class Codex extends RealCodex{constructor(options){super({...options,codexPathOverride:${JSON.stringify(cli)}})}}`);
  await copyFile(new URL('../server/e2b-worker.mjs', import.meta.url), join(directory, 'e2b-worker.mjs'));
  await copyFile(new URL('../server/diagnostic-proxy.mjs', import.meta.url), join(directory, 'diagnostic-proxy.mjs'));
  for (const threadId of [null, 'existing-thread']) {
    const inputPath = join(directory, 'input.json');
    await writeFile(inputPath, JSON.stringify({ threadId, prompt: 'Synthetic worker check', images: [],
      modelConfig: { sandbox_mode: 'workspace-write' }, configOverrides: ['sandbox_mode="read-only"'],
      settings: { workingDirectory: directory, model: '', modelReasoningEffort: 'medium', sandboxMode: 'workspace-write', networkAccessEnabled: false, webSearchMode: 'disabled' },
    }));
    await promisify(execFile)(process.execPath, [join(directory, 'e2b-worker.mjs'), inputPath], { env: { PATH: process.env.PATH, HOME: directory }, timeout: 10000 });
    const args = JSON.parse(await readFile(capture, 'utf8')) as string[];
    assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
    assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
    assert.ok(args.indexOf('sandbox_mode="read-only"') < args.indexOf('--sandbox'));
    assert.equal(args.includes('resume'), threadId !== null);
    if (threadId) assert.ok(args.includes(threadId));
  }
});
