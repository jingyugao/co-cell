import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parseConfig, startLauncher } from './launcher.mjs';
import { attachReleaseSkills } from './release-skills.mjs';

test('upgrading release skills updates both harnesses and preserves personal skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-release-skills-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  const directories = [join(home, '.agents/skills'), join(workspace, '.cocell/codex/skills'), join(workspace, '.cocell/claude/skills')];
  try {
    for (const directory of directories) await mkdir(join(directory, 'personal'), { recursive: true });
    for (const [sha, names] of [['a', ['shared', 'removed', 'personal']], ['b', ['shared', 'added', 'personal']]]) {
      const assets = join(root, 'versions', sha.repeat(64), 'assets');
      for (const name of names) await mkdir(join(assets, 'skills', name), { recursive: true });
      await attachReleaseSkills(assets, home, workspace);
      for (const directory of directories) {
        assert.equal(await readlink(join(directory, 'shared')), join(assets, 'skills/shared'));
        assert.equal((await stat(join(directory, 'personal'))).isDirectory(), true);
        await assert.rejects(readlink(join(directory, 'personal')), { code: 'EINVAL' });
        if (sha === 'b') {
          assert.equal(await readlink(join(directory, 'added')), join(assets, 'skills/added'));
          await assert.rejects(readlink(join(directory, 'removed')), { code: 'ENOENT' });
        }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('external model metadata reaches App Server without replacing built-in models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-model-catalog-'));
  const workspace = join(root, 'workspace'), startupDirectory = join(root, 'startup');
  const report = join(root, 'report.json'), codex = join(root, 'codex.mjs');
  const original = { slug: 'template', base_instructions: 'You are an agent based on GPT-5.', experimental_supported_tools: [] };
  const stop = new AbortController(); let launched;
  try {
    await mkdir(workspace); await mkdir(startupDirectory);
    await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'debug') { console.log(JSON.stringify({ models: [${JSON.stringify(original)}] })); process.exit(0); }
const argument = process.argv.find(arg => arg.startsWith('model_catalog_json='));
const path = JSON.parse(argument.slice(argument.indexOf('=') + 1));
writeFileSync(${JSON.stringify(report)}, JSON.stringify({path, catalog:JSON.parse(readFileSync(path)), metadata:process.env.CODEX_MODEL_METADATA_JSON}));
process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);
`, { mode: 0o755 });
    await writeFile(join(startupDirectory, 'config.json'), JSON.stringify({ version: 1, appServerArgs: [], env: {
      CODEX_MODEL_METADATA_JSON: JSON.stringify({ 'external-model': { template: 'template', experimental_supported_tools: ['send_user_message_async'] } }),
    } }), { mode: 0o600 });
    launched = startLauncher({ workspace, agentHome: join(root, 'agent'), startupDirectory, codex, signal: stop.signal,
      acpHost: async () => { throw new Error('ACP port unavailable'); }, log: () => {} });
    await until(async () => Boolean(await stat(report).catch(() => null)));
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.deepEqual(result.catalog.models[0], original);
    assert.equal(result.catalog.models[1].slug, 'external-model');
    assert.deepEqual(result.catalog.models[1].experimental_supported_tools, ['send_user_message_async']);
    assert(result.catalog.models[1].base_instructions.includes('using external-model'));
    assert.equal(result.metadata, undefined);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  } finally { stop.abort(); if (launched) await launched; await rm(root, { recursive: true, force: true }); }
});

async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for test condition');
}

test('shared startup is reusable across restored workspaces and sees atomic document updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-mounted-launcher-'));
  const workspace = join(root, 'workspace'), sharedDirectory = join(root, 'shared');
  const home = join(workspace, '.cocell', 'codex');
  const report = join(root, 'report.json'), codex = join(root, 'codex.mjs');
  let stop, launched;
  try {
    await mkdir(join(home, 'docs'), { recursive: true });
    await mkdir(join(root, 'agent'));
    await symlink(join(root, 'old-workspace', '.cocell', 'codex'), join(root, 'agent', '.codex'));
    await writeFile(join(home, 'AGENTS.md'), 'archived instructions');
    await writeFile(join(home, 'docs', 'old.txt'), 'archived copy');
    await mkdir(join(sharedDirectory, 'runtime'), { recursive: true });
    await mkdir(join(sharedDirectory, 'docs'));
    await writeFile(join(sharedDirectory, 'AGENTS.md'), 'current instructions');
    await writeFile(join(sharedDirectory, 'docs', 'live.txt'), 'first');
    await writeFile(codex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(report)}, JSON.stringify({key: process.env.CODEX_API_KEY, home: process.env.CODEX_HOME}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const configPath = join(sharedDirectory, 'runtime', 'config.json');
    for (const key of ['first-key', 'second-key']) {
      await rm(report, { force: true });
      await writeFile(configPath, JSON.stringify({ version: 1, appServerArgs: [], env: { CODEX_API_KEY: key } }), { mode: 0o644 });
      stop = new AbortController();
      launched = startLauncher({ agentHome: join(root, 'agent'), workspace, sharedDirectory, codex, signal: stop.signal, log: () => {} });
      await until(async () => Boolean(await stat(report).catch(() => null)));
      assert.equal(JSON.parse(await readFile(report, 'utf8')).key, key);
      assert.equal(await readlink(join(home, 'docs')), join(sharedDirectory, 'docs'));
      assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), 'current instructions');
      assert.equal(await readFile(join(root, 'agent', '.codex', 'AGENTS.md'), 'utf8'), 'current instructions');
      assert(await stat(configPath)); // read-only shared config is never consumed.
      await writeFile(join(sharedDirectory, 'docs', 'new.tmp'), key);
      await rename(join(sharedDirectory, 'docs', 'new.tmp'), join(sharedDirectory, 'docs', 'live.txt'));
      assert.equal(await readFile(join(home, 'docs', 'live.txt'), 'utf8'), key);
      assert.equal(await readFile(join(root, 'agent', '.codex', 'docs', 'live.txt'), 'utf8'), key);
      assert.equal(await stat(join(home, 'docs', 'old.txt')).catch(() => null), null);
      stop.abort();
      assert.equal(await launched, 0);
    }
  } finally {
    stop?.abort();
    if (launched) await launched;
    await rm(root, { recursive: true, force: true });
  }
});

test('provisioning waits, starts once on loopback, keeps Codex history, and stops cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-launcher-'));
  const workspace = join(root, 'workspace');
  const startupDirectory = join(root, 'startup');
  await mkdir(workspace);
  const report = join(workspace, 'report.json');
  const fakeCodex = join(workspace, 'fake-codex.mjs');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.APP_TEST_REPORT, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), env: process.env}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const stop = new AbortController();
  const previousEnv = { PATH: process.env.PATH, CELLBOX_TOKEN: process.env.CELLBOX_TOKEN, VIRTUAL_ENV: process.env.VIRTUAL_ENV };
  process.env.PATH = `/opt/project-tools/bin:${process.env.PATH}`;
  process.env.CELLBOX_TOKEN = 'internal-token';
  process.env.VIRTUAL_ENV = '/opt/project-venv';
  try {
    const launched = startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory, codex: fakeCodex, pollMs: 20,
      signal: stop.signal, log: () => {} });
    const configPath = join(startupDirectory, 'config.json');
    await until(async () => (await stat(startupDirectory).catch(() => null)) !== null);
    assert.equal(await stat(report).catch(() => null), null);
    await writeFile(configPath, JSON.stringify({ version: 1, appServerArgs: ['-c', 'model="test"', '-c', 'sandbox_mode="workspace-write"'],
      env: { APP_TEST_REPORT: report, OPENAI_API_KEY: 'test-secret' } }), { mode: 0o600 });
    await until(async () => (await stat(report).catch(() => null)) !== null);
    const first = JSON.parse(await readFile(report, 'utf8'));
    assert.deepEqual(first.args, ['app-server', '-c', 'model="test"', '-c', 'sandbox_mode="workspace-write"',
      '-c', 'sandbox_mode="danger-full-access"', '--listen', 'ws://127.0.0.1:4500']);
    assert.equal(first.cwd, workspace);
    assert.equal(first.env.CODEX_HOME, join(workspace, '.cocell', 'codex'));
    assert.equal(first.env.HOME, join(root, 'agent'));
    assert.equal(await readlink(join(root, 'agent', '.codex')), first.env.CODEX_HOME);
    assert.equal(first.env.OPENAI_API_KEY, 'test-secret');
    assert.equal(first.env.CELLBOX_TOKEN, undefined);
    assert.equal(first.env.PATH, process.env.PATH);
    assert.equal(first.env.VIRTUAL_ENV, '/opt/project-venv');
    assert.equal(await stat(configPath).catch(() => null), null);
    assert.equal((await stat(join(workspace, '.cocell', 'codex'))).mode & 0o777, 0o700);
    await writeFile(configPath, JSON.stringify({ version: 1, appServerArgs: [], env: {} }), { mode: 0o600 });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await readFile(report, 'utf8'), JSON.stringify(first));
    stop.abort();
    assert.equal(await launched, 0);
  } finally {
    stop.abort();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an insecure config file and remote listener overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-launcher-'));
  const workspace = join(root, 'workspace');
  const startupDirectory = join(root, 'startup');
  await mkdir(workspace);
  const stop = new AbortController();
  try {
    const configDir = startupDirectory;
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, appServerArgs: [], env: {} }));
    await chmod(configPath, 0o640);
    await assert.rejects(startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory, codex: '/does/not/matter', pollMs: 10,
      signal: stop.signal, log: () => {} }), /mode 0600/);
    const existingHome = join(root, 'agent', '.codex');
    await rm(existingHome);
    await mkdir(existingHome);
    await writeFile(join(existingHome, 'config.toml'), 'existing configuration');
    await assert.rejects(startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory,
      signal: stop.signal, log: () => {} }), /existing configuration/);
    assert.equal(await readFile(join(existingHome, 'config.toml'), 'utf8'), 'existing configuration');
    assert.throws(() => parseConfig(JSON.stringify({ version: 1,
      appServerArgs: ['--listen', 'ws://0.0.0.0:4500'], env: {} })), /config or feature/);
    assert.throws(() => parseConfig(JSON.stringify({ version: 1,
      appServerArgs: [], env: { CELLBOX_TOKEN: 'private' } })), /invalid provisioning/);
  } finally {
    stop.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test('starts the npm Codex entrypoint when workload PATH cannot find Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-launcher-path-'));
  const workspace = join(root, 'workspace');
  const startupDirectory = join(root, 'startup');
  const report = join(root, 'report.json');
  const fakeCodex = join(root, 'codex.mjs');
  const originalPath = process.env.PATH;
  const stop = new AbortController();
  let launched;
  try {
    await mkdir(workspace);
    await mkdir(startupDirectory);
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ path: process.env.PATH }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    await writeFile(join(startupDirectory, 'config.json'), JSON.stringify({ version: 1, appServerArgs: [], env: {} }), { mode: 0o600 });
    process.env.PATH = '/opt/project-tools/without-node';
    launched = startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory, codex: fakeCodex, signal: stop.signal, log: () => {} });
    await until(async () => (await stat(report).catch(() => null)) !== null);
    assert.equal(JSON.parse(await readFile(report, 'utf8')).path, `${dirname(process.execPath)}:/opt/project-tools/without-node`);
    stop.abort();
    assert.equal(await launched, 0);
  } finally {
    stop.abort();
    if (launched) await launched;
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('unexpected Codex exit is reported as launcher failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-launcher-'));
  const workspace = join(root, 'workspace');
  const startupDirectory = join(root, 'startup');
  await mkdir(workspace);
  const fakeCodex = join(workspace, 'fake-codex.mjs');
  try {
    await writeFile(fakeCodex, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    const configDir = startupDirectory;
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ version: 1,
      appServerArgs: [], env: {} }), { mode: 0o600 });
    const logs = [];
    assert.equal(await startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory, codex: fakeCodex, pollMs: 10,
      signal: new AbortController().signal, log: message => logs.push(message) }), 1);
    assert.ok(logs.some(message => message.includes('exited (code 0')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude ACP host reconciles durable answers once and preserves unknown outcomes', { timeout: 15_000 }, async () => {
  const { startClaudeAcpHost } = await import('./acp/server.mjs');
  const root = await mkdtemp(join(tmpdir(), 'cocell-acp-host-'));
  const workspace = join(root, 'workspace');
  const directory = join(workspace, '.cocell', 'claude-acp');
  const command = join(root, 'agent.mjs');
  const counter = join(root, 'counter');
  const configLog = join(root, 'config-log');
  const id = '9dbbf207-acfd-401d-b65c-077679dd3b5a';
  const native = 'e051d0eb-e40c-4d29-879e-d640367f6ad7';
  const turnId = 'a2c32b2d-a1d0-4351-a149-02a27436789f';
  const answerId = '013afdf7-f906-49e8-bd4a-081e0b7294b8';
  const stamp = new Date().toISOString();
  let host;
  try {
    await mkdir(directory, { recursive: true });
    const state = { id, cwd: workspace, threadId: native, turns: [{ id: turnId, prompt: 'question', images: [], status: 'completed', items: [], startedAt: stamp,
      userInputRequests: [{ id: 'q', questions: [{ title: 'Choice?' }], status: 'queued', deliveryStatus: 'queued', answers: ['A'], answerTurnId: answerId, createdAt: stamp },
        { id: 'unknown', questions: [{ title: 'Unknown?' }], status: 'queued', deliveryStatus: 'unknown', answers: ['B'], answerTurnId: 'c3fded45-dd07-4b07-85d9-0fcf3d438fda', createdAt: stamp },
        { id: 'q-switch', questions: [{ title: 'Choice after switch?' }], status: 'pending', createdAt: stamp }] }] };
    await writeFile(join(directory, id + '.json'), JSON.stringify(state));
    const adapter = [
      '#!' + process.execPath,
      "import { appendFileSync, closeSync } from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      "const send = v => process.stdout.write(JSON.stringify(v) + '\\n');",
      'let held, selectedModel, selectedEffort, permissionMode;',
      'createInterface({input:process.stdin}).on("line", line => {',
      '  const m=JSON.parse(line);',
      '  if(m.method==="session/cancel"){ if(held)send({jsonrpc:"2.0",id:held,result:{stopReason:"cancelled"}}); return; }',
      '  if(m.id===undefined)return;',
      '  if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1}});',
      '  if(m.method==="session/set_mode"){ permissionMode=m.params.modeId; return send({jsonrpc:"2.0",id:m.id,result:{}}); }',
      '  if(m.method==="session/load"){',
      '    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"OLD_HISTORY"}}}});',
      '    return send({jsonrpc:"2.0",id:m.id,result:{}});',
      '  }',
      '  if(m.method==="session/set_config_option"){',
      '    appendFileSync(' + JSON.stringify(configLog) + ', JSON.stringify(m.params) + "\\n");',
      '    if(m.params.configId==="effort" && m.params.value==="max") return send({jsonrpc:"2.0",id:m.id,error:{code:-32602,message:"effort rejected"}});',
      '    if(m.params.configId==="model") selectedModel=m.params.value;',
      '    if(m.params.configId==="effort") selectedEffort=m.params.value;',
      '    return send({jsonrpc:"2.0",id:m.id,result:{}});',
      '  }',
      '  if(m.method==="_session/steering")return send({jsonrpc:"2.0",id:m.id,result:{outcome:"promptRequired",reason:"noRunningTurn"}});',
      '  if(m.method==="session/prompt"){',
      '    if(permissionMode!=="bypassPermissions")return send({jsonrpc:"2.0",id:m.id,error:{code:-32603,message:"Expected bypassPermissions before prompt"}});',
      '    if(m.params.prompt[0].text==="BREAK"){closeSync(0); setInterval(()=>{}, 1000); return;}',
      '    if(m.params.prompt[0].text==="HOLD"){',
      '      held=m.id;',
      '      for(let i=0;i<300;i++)send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"agent_message_chunk",messageId:"burst",content:{type:"text",text:"x"}}}});',
      '      for(let i=0;i<300;i++)send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"usage_update",used:i}}});',
      '      return;',
      '    }',
      '    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"agent_thought_chunk",messageId:"shared",content:{type:"text",text:"thinking"}}}});',
      '    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"agent_message_chunk",messageId:"shared",content:{type:"text",text:"visible "}}}});',
      '    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"agent_message_chunk",messageId:"shared",content:{type:"text",text:"answer"}}}});',
      '    appendFileSync(' + JSON.stringify(counter) + ', JSON.stringify({text:m.params.prompt[0].text,openAiEnv:!!process.env.OPENAI_API_KEY,channel:process.env.ANTHROPIC_BASE_URL,key:process.env.ANTHROPIC_API_KEY,model:selectedModel,effort:selectedEffort,haiku:process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,sonnet:process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,opus:process.env.ANTHROPIC_DEFAULT_OPUS_MODEL}) + "\\n");',
      '    return send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});',
      '  }',
      '  return send({jsonrpc:"2.0",id:m.id,result:{}});',
      '});',
    ].join('\n');
    await writeFile(command, adapter, { mode: 0o755 });
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-reach-claude';
    try {
      host = await startClaudeAcpHost({ directory, workspace, agentHome: root, command, port: 0 });
      let base = 'http://127.0.0.1:' + host.port;
      const path = '/sessions/' + id;
      assert.equal((await (await fetch(base + '/health')).json()).active, true);
      const resume = () => fetch(base + path + '/reconcile', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({cwd:workspace,env:{ANTHROPIC_API_KEY:'test-only'}}) });
      const attempts = await Promise.all([resume(), resume()]);
      assert.deepEqual(attempts.map(response => response.status), [200, 200]);
      let snapshot;
      for (let attempt = 0; attempt < 200; attempt++) {
        snapshot = await (await fetch(base + path)).json();
        if (snapshot.turns[1]?.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.equal(snapshot.turns.length, 2);
      assert.equal(snapshot.turns[1].status, 'completed');
      assert.equal(snapshot.turns[0].userInputRequests[0].status, 'answered');
      assert.equal(snapshot.turns[0].userInputRequests[1].deliveryStatus, 'unknown');
      assert.ok(snapshot.turns[1].items.every(item => item.text !== 'OLD_HISTORY'));
      const sent = (await readFile(counter, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Answer: A/);
      assert.equal(sent[0].openAiEnv, false);
      const answerAfterSwitch = await fetch(base + path + '/answers', { method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({ ownerTurnId:turnId, requestId:'q-switch', answers:['new'], cwd:workspace,
          model:'new-model', effort:'xhigh', env:{ ANTHROPIC_BASE_URL:'https://new.example', ANTHROPIC_API_KEY:'new-secret', ANTHROPIC_MODEL:'new-model',
            ANTHROPIC_DEFAULT_HAIKU_MODEL:'fast-model', ANTHROPIC_DEFAULT_SONNET_MODEL:'work-model', ANTHROPIC_DEFAULT_OPUS_MODEL:'deep-model' } }) });
      assert.equal(answerAfterSwitch.status, 200);
      for (let attempt = 0; attempt < 200; attempt++) {
        snapshot = await (await fetch(base + path)).json();
        if (snapshot.turns[2]?.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.equal(snapshot.turns[2].status, 'completed');
      assert.equal(snapshot.turns[2].items.find(item => item.type === 'agent_message')?.text, 'visible answer');
      assert.equal(snapshot.turns[2].items.find(item => item.type === 'reasoning')?.text, 'thinking');
      assert.notEqual(snapshot.turns[2].items.find(item => item.type === 'agent_message')?.id,
        snapshot.turns[2].items.find(item => item.type === 'reasoning')?.id);
      const switched = (await readFile(counter, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(switched.length, 2);
      assert.equal(switched[1].channel, 'https://new.example');
      assert.equal(switched[1].key, 'new-secret');
      assert.equal(switched[1].model, 'new-model');
      assert.equal(switched[1].effort, 'xhigh');
      assert.equal(switched[1].haiku, 'fast-model');
      assert.equal(switched[1].sonnet, 'work-model');
      assert.equal(switched[1].opus, 'deep-model');
      const turnEnv = { ANTHROPIC_BASE_URL:'https://new.example', ANTHROPIC_API_KEY:'new-secret', ANTHROPIC_MODEL:'new-model',
        ANTHROPIC_DEFAULT_HAIKU_MODEL:'fast-model', ANTHROPIC_DEFAULT_SONNET_MODEL:'work-model', ANTHROPIC_DEFAULT_OPUS_MODEL:'deep-model' };
      const submitEffort = async (id, effort) => {
        const response = await fetch(base + path + '/turns', { method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify({ id, prompt:'effort check', images:[], cwd:workspace, model:'new-model', effort, env:turnEnv }) });
        assert.equal(response.status, 200);
        for (let attempt = 0; attempt < 200; attempt++) {
          snapshot = await (await fetch(base + path)).json();
          const turn = snapshot.turns.find(value => value.id === id);
          if (turn?.status !== 'running') return turn;
          await new Promise(resolve => setTimeout(resolve, 15));
        }
        throw new Error('Timed out waiting for effort check');
      };
      const reset = await submitEffort('88dbdd89-f202-4b8d-bb1a-a54c74f18122');
      assert.equal(reset.status, 'completed');
      assert.equal((await submitEffort('d8dd5b38-8027-400a-90ea-150c800748ca', 'low')).status, 'completed');
      assert.equal((await submitEffort('e8856989-e568-45a8-b6ab-201402d35a79', 'default')).status, 'completed');
      const rejected = await submitEffort('7e358647-a617-435c-b163-1c86ce168e17', 'max');
      assert.equal(rejected.status, 'failed');
      assert.match(rejected.error, /effort rejected/);
      assert.equal((await submitEffort('c2e0dc1d-d2a7-4207-9c23-a804d082424f', 'default')).status, 'completed');
      const configs = (await readFile(configLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(configs.filter(entry => entry.configId === 'effort').map(entry => entry.value), ['xhigh', 'default', 'low', 'default', 'max']);
      assert.equal((await readFile(join(directory, id + '.json'), 'utf8')).includes('new-secret'), false);
      assert.equal((await (await fetch(base + '/health')).json()).active, false);
      const project = workspace.replace(/[^a-zA-Z0-9]/g, '-');
      const transcriptDir = join(workspace, '.cocell', 'claude', 'projects', project);
      await mkdir(transcriptDir, { recursive: true });
      const transcript = join(transcriptDir, native + '.jsonl');
      await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: native, cwd: workspace }) + '\n');
      assert.equal((await (await fetch(base + path + '/verify')).json()).verified, true);
      await rm(transcript);
      assert.equal((await fetch(base + path + '/verify')).status, 409);
      // Allow the host's bounded streaming flush to settle before checking the ETag.
      await new Promise(resolve => setTimeout(resolve, 200));
      const response = await fetch(base + path);
      const etag = response.headers.get('etag');
      assert.equal((await fetch(base + path, { headers:{'if-none-match':etag} })).status, 304);
      await host.close();
      host = await startClaudeAcpHost({ directory, workspace, agentHome: root, command, port: 0 });
      base = 'http://127.0.0.1:' + host.port;
      assert.equal((await fetch(base + path, { headers:{'if-none-match':etag} })).status, 200);
      const holdId = '4ad51254-999d-4255-b0a3-b4f9ba3b891b';
      const { watch } = await import('node:fs');
      let writes = 0;
      const watcher = watch(directory, (event, file) => { if (event === 'rename' && file === id + '.json') writes++; });
      const submit = await fetch(base + path + '/turns', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ id:holdId, prompt:'HOLD', images:[], cwd:workspace, env:{ANTHROPIC_API_KEY:'test-only'} }) });
      assert.equal(submit.status, 200);
      let burst;
      for (let attempt = 0; attempt < 200; attempt++) {
        snapshot = await (await fetch(base + path)).json();
        burst = snapshot.turns.at(-1)?.items.find(item => item.id === 'agent_message_chunk:burst');
        if (burst?.text.length === 300) break;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.equal(burst?.text, 'x'.repeat(300));
      await new Promise(resolve => setTimeout(resolve, 200));
      watcher.close();
      assert.ok(writes <= 3, 'Streaming chunks should share a bounded number of durable writes: ' + writes);
      const steerId = 'a177cf32-2db5-4da7-bd8f-5f9369aa150c';
      const steer = () => fetch(base + path + '/turns', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ id:steerId, prompt:'STEER', images:[], cwd:workspace, env:{ANTHROPIC_API_KEY:'test-only'} }) });
      assert.equal((await steer()).status, 422);
      assert.equal((await steer()).status, 422);
      assert.equal((await fetch(base + path + '/stop', { method:'POST' })).status, 200);
      for (let attempt = 0; attempt < 200; attempt++) {
        snapshot = await (await fetch(base + path)).json();
        if (snapshot.turns.at(-1)?.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.equal(snapshot.turns.at(-1).status, 'cancelled');
      assert.equal(snapshot.turns.at(-1).items.find(item => item.id === 'agent_message_chunk:burst')?.text, 'x'.repeat(300));
      const brokenId = '1271eccf-4c63-4242-852b-f862d6af1a8b';
      const broken = await fetch(base + path + '/turns', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ id:brokenId, prompt:'BREAK', images:[], cwd:workspace, env:{ANTHROPIC_API_KEY:'test-only'} }) });
      assert.equal(broken.status, 200);
      await new Promise(resolve => setTimeout(resolve, 100));
      await fetch(base + path + '/stop', { method:'POST' });
      for (let attempt = 0; attempt < 200; attempt++) {
        snapshot = await (await fetch(base + path)).json();
        if (snapshot.turns.at(-1)?.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.equal(snapshot.turns.at(-1).status, 'failed');
      assert.equal((await (await fetch(base + '/health')).json()).active, false);
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    }
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});
