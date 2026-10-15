import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../../util/errors.js';
import { readManagedRequirementInfo } from './requirements.js';

// Exercise the real subprocess boundary: auth status deliberately exits nonzero.
const cli = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const home = process.env.HOME;
fs.appendFileSync(process.env.COCELL_TEST_HOMES, home + '\\n');
if (Object.keys(process.env).some(key => key.startsWith('MEEGLE_'))) throw Error('ambient account leaked');
const configPath = path.join(home, '.meegle/config.json');
if ((fs.statSync(home).mode & 0o777) !== 0o700 || (fs.statSync(configPath).mode & 0o777) !== 0o600) throw Error('unsafe permissions');
const config = JSON.parse(fs.readFileSync(configPath));
if (config.profiles.default.user_access_token !== 'synthetic-selected-token') throw Error('wrong account');
const [resource] = process.argv.slice(2);
const host = 'project.example.test';
if (resource === 'url') console.log(JSON.stringify({url_kind:'workitem_detail', host, simple_name:'sample', work_item_id:'42'}));
else if (resource === 'auth') {
  if (config.mode === 'malformed') { console.log('synthetic-selected-token'); process.exit(1); }
  console.log(JSON.stringify(config.mode === 'ok' ? {authenticated:true,host} : {authenticated:false,host,reason:'synthetic-selected-token'}));
  process.exit(config.mode === 'ok' ? 0 : config.mode === 'network' ? 2 : 1);
} else if (resource === 'project') console.log(JSON.stringify({projects:[{project_key:'canonical',simple_name:'sample'}]}));
else if (resource === 'workitem') console.log(JSON.stringify({work_item_attribute:{work_item_id:'42',work_item_name:'Selected requirement',owned_project:{key:'canonical'},status:{name:'进行中'}}}));
else process.exit(3);
`;

test('managed requirement reads isolate credentials, distinguish auth/network failures and clean private HOME', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-requirement-test-'));
  const previous = { PATH: process.env.PATH, MEEGLE_HOST: process.env.MEEGLE_HOST,
    MEEGLE_USER_ACCESS_TOKEN: process.env.MEEGLE_USER_ACCESS_TOKEN, COCELL_TEST_HOMES: process.env.COCELL_TEST_HOMES };
  try {
    await writeFile(join(directory, 'meegle'), cli, { mode: 0o700 });
    process.env.PATH = directory + ':' + previous.PATH;
    process.env.MEEGLE_HOST = 'wrong.example.test';
    process.env.MEEGLE_USER_ACCESS_TOKEN = 'synthetic-ambient-token';
    process.env.COCELL_TEST_HOMES = join(directory, 'homes');
    for (const mode of ['ok', 'missing', 'network', 'malformed']) {
      const secrets = { async defaultToolCredential(tool: string) {
        assert.equal(tool, 'meegle');
        return { path: '.meegle/config.json', content: JSON.stringify({ mode, current: 'default', profiles: { default: { host: 'project.example.test', user_access_token: 'synthetic-selected-token' } } }) };
      } };
      const result = readManagedRequirementInfo('https://project.example.test/sample/story/detail/42', secrets);
      if (mode === 'ok') assert.deepEqual(await result, { name: 'Selected requirement', status: '进行中' });
      else await assert.rejects(result, (error: unknown) => {
        assert(error instanceof HttpError);
        assert.equal(error.status, mode === 'missing' ? 409 : 502);
        assert(!error.message.includes('synthetic-'));
        return true;
      });
    }
    const homes = (await readFile(process.env.COCELL_TEST_HOMES, 'utf8')).trim().split('\n');
    assert.equal(new Set(homes).size, 4, 'each lookup owns a separate HOME');
    for (const home of homes) await assert.rejects(readFile(join(home, '.meegle/config.json')), { code: 'ENOENT' });
    await assert.rejects(readManagedRequirementInfo('https://project.example.test/sample/story/detail/42', {
      async defaultToolCredential() { return null; },
    }), (error: unknown) => error instanceof HttpError && error.status === 409 && /默认角色/.test(error.message));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
