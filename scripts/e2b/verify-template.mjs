import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { CommandExitError, Sandbox } from 'e2b';
import { templatePaths } from './options.mjs';

// Creates and deletes only its own verification sandbox. No model/API calls.
const paths = templatePaths();
const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
const alias = paths.alias ?? manifest.template;
const { localConfig } = await import(pathToFileURL(`${homedir()}/.data/e2b/client/config.mjs`).href);
const connection = { ...await localConfig(), requestTimeoutMs: 10_000 };
const report = { template: alias, startedAt: new Date().toISOString(), sandboxId: null, checks: [], deleted: false, passed: false };
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
let sandbox;
let failed = false;
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

async function command(name, script, cwd = '/home/user/workspace') {
  const start = Date.now();
  report.activeCheck = name;
  let result;
  try {
    shutdown.signal.throwIfAborted();
    result = await sandbox.commands.run(script, { user: 'user', cwd, timeoutMs: 180_000, signal: shutdown.signal });
  } catch (error) {
    // Only command output is recorded, never SDK requests or connection options.
    report.checks.push({ name, failed: true, durationMs: Date.now() - start, ...(error instanceof CommandExitError ? {
      output: error.stdout.trim(), stderr: error.stderr.trim(), exitCode: error.exitCode,
    } : {}) });
    throw error;
  }
  const output = result.stdout.trim();
  report.checks.push({ name, output, stderr: result.stderr.trim(), exitCode: result.exitCode, durationMs: Date.now() - start });
  assert.equal(result.exitCode, 0, `${name} exited unsuccessfully`);
  console.log(`${name}: ${output}`);
  return output;
}

try {
  sandbox = await Sandbox.create(alias, {
    ...connection,
    timeoutMs: 900_000,
    // Verification sandboxes are disposable; interrupted verification must not
    // leave a paused VM indefinitely. User project lifecycle is unaffected.
    lifecycle: { onTimeout: 'kill', autoResume: false },
    metadata: { app: 'codex-template-verification' },
  });
  report.sandboxId = sandbox.sandboxId;
  console.log(`Verification sandbox: ${sandbox.sandboxId}`);
  await command('Git client', 'git --version', '/home/user');
  assert.match(await command('GitLab CLI', 'glab --version', '/home/user'), /^glab(?: version)? v?1\.116\.0(?:[ (]|$)/);
  await command('GitLab credential helper', 'glab auth git-credential --help >/dev/null', '/home/user');
  assert.match(await command('Oracle MySQL client', 'mysql --version', '/home/user'), /8\.0\.46/);
  await command('MySQL login-path support', "mysql --no-defaults --help | grep -F -- '--login-path'", '/home/user');
  await command('MySQL login-path editor', 'mysql_config_editor --version', '/home/user');
  assert.equal(await command('Lark CLI', 'lark-cli --version', '/home/user'), 'lark-cli version 1.0.89');
  assert.equal(await command('Meegle CLI', 'meegle --version', '/home/user'), '1.0.20');
  const kubectl = JSON.parse(await command('Kubernetes CLI client', 'kubectl version --client -o json', '/home/user'));
  assert.equal(kubectl.clientVersion.gitVersion, 'v1.35.1');
  assert.equal(kubectl.clientVersion.platform, 'linux/amd64');
  await command('Lark document and comment commands', 'lark-cli docs --help >/dev/null && lark-cli drive +list-comments --help >/dev/null && lark-cli drive +add-comment --help >/dev/null', '/home/user');
  await command('Meegle command discovery', 'meegle --help >/dev/null && meegle inspect --help >/dev/null', '/home/user');
  await command('tmux', 'tmux -V', '/home/user');
  const root = '/home/user/workspace/template-verification';
  await command('create fixtures', `mkdir -p ${quote(root)} ${manifest.go.map((v) => quote(`${root}/go-${v}`)).join(' ')} ${quote(`${root}/web`)}`);
  if (manifest.php) {
    assert.equal(manifest.php.version, '8.0.30', 'PHP verification targets the project Docker runtime');
    assert.equal(await command('PHP version', "php -r 'echo PHP_VERSION;'", '/home/user'), manifest.php.version);
    const composerVersion = await command('Composer version', 'composer --no-plugins --no-scripts --version', '/home/user');
    assert.equal(/^Composer version (\d+\.\d+\.\d+)(?:\s|$)/.exec(composerVersion)?.[1], manifest.php.composer.version);
    const extensions = ['bcmath', 'ctype', 'curl', 'dom', 'fileinfo', 'gd', 'iconv', 'json', 'libxml', 'mbstring', 'mysqli', 'openssl', 'pcntl', 'pdo', 'pdo_mysql', 'posix', 'redis', 'SimpleXML', 'sockets', 'xml', 'xmlreader', 'xmlwriter', 'yaml', 'zip', 'zlib'];
    const actualExtensions = JSON.parse(await command('PHP extensions', "php -r 'echo json_encode(get_loaded_extensions());'", '/home/user'));
    const loaded = new Set(actualExtensions.map(name => name.toLowerCase()));
    assert.deepEqual(extensions.filter(name => !loaded.has(name.toLowerCase())), [], 'Missing project PHP extensions');
    const phpDirectory = `${root}/php`;
    await command('create PHP fixtures', `mkdir -p ${quote(phpDirectory)}`);
    await sandbox.files.write(`${phpDirectory}/check.php`, `<?php
// Self-contained extension checks: no app bootstrap, Redis connection or database.
function verify($condition, $message) { if (!$condition) { throw new RuntimeException($message); } }
$parsed = yaml_parse("name: template-verification\\nitems: [one, two]\\n");
verify($parsed['name'] === 'template-verification' && count($parsed['items']) === 2, 'YAML parser failed');
$redis = new Redis();
verify(!$redis->isConnected(), 'Redis fixture must remain disconnected');
verify(bcadd('0.1', '0.2', 2) === '0.30', 'BCMath arithmetic failed');
$path = tempnam(sys_get_temp_dir(), 'php-template-zip-');
verify($path !== false, 'Unable to allocate ZIP fixture');
try {
    $zip = new ZipArchive();
    verify($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) === true, 'Unable to create ZIP fixture');
    verify($zip->addFromString('fixture.txt', 'template-zip-ok'), 'Unable to write ZIP fixture');
    verify($zip->close(), 'Unable to close ZIP fixture');
    verify($zip->open($path) === true, 'Unable to reopen ZIP fixture');
    verify($zip->getFromName('fixture.txt') === 'template-zip-ok', 'ZIP round-trip failed');
    $zip->close();
} finally { if (is_file($path)) { unlink($path); } }
echo json_encode(['yaml' => true, 'redisDisconnected' => true, 'bcmath' => true, 'zip' => true]);
`, { user: 'user' });
    const extensionChecks = JSON.parse(await command('PHP local extension fixtures', 'php check.php', phpDirectory));
    assert.deepEqual(extensionChecks, { yaml: true, redisDisconnected: true, bcmath: true, zip: true });
    const marker = `php-template-${report.sandboxId}`;
    await sandbox.files.write(`${phpDirectory}/index.php`, `<?php header('Content-Type: application/json'); echo json_encode(['marker' => '${marker}', 'php' => PHP_VERSION]);\n`, { user: 'user' });
    const httpCheck = `
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const environment = { ...process.env };
delete environment.PHP_CLI_SERVER_WORKERS;
const child = spawn('php', ['-S', '127.0.0.1:18765', '-t', ${JSON.stringify(phpDirectory)}], {
  cwd: ${JSON.stringify(phpDirectory)}, stdio: ['ignore', 'ignore', 'pipe'],
  env: environment
});
let spawnError;
child.once('error', error => { spawnError = error; });
child.stderr.resume();
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const alive = () => child.pid && child.exitCode === null && child.signalCode === null;
(async () => {
  try {
    let result;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (spawnError || !alive()) throw Error('PHP fixture server failed to start');
      try {
        const response = await fetch('http://127.0.0.1:18765/', { signal: AbortSignal.timeout(1000) });
        const candidate = await response.json();
        if (response.ok && candidate.marker === ${JSON.stringify(marker)} && candidate.php === '8.0.30') { result = candidate; break; }
      } catch { /* Wait only for our local fixture server. */ }
      await delay(100);
    }
    if (!result || !alive()) throw Error('PHP fixture HTTP response did not match');
    console.log(JSON.stringify(result));
  } finally {
    if (alive()) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2000)]);
      if (alive()) { child.kill('SIGKILL'); await Promise.race([exited, delay(2000)]); }
      if (alive()) throw Error('PHP fixture server cleanup failed');
    }
  }
})().catch(() => { console.error('PHP fixture HTTP verification failed'); process.exitCode = 1; });`;
    assert.deepEqual(JSON.parse(await command('PHP CLI HTTP server', `node -e ${quote(httpCheck)}`, phpDirectory)), { marker, php: '8.0.30' });
  }
  for (const version of manifest.go) {
    const directory = `${root}/go-${version}`;
    await sandbox.files.write(`${directory}/mise.toml`, `[tools]\ngo = "${version}"\n`, { user: 'user' });
    await sandbox.files.write(`${directory}/go.mod`, 'module template-verification\n\ngo 1.22\n', { user: 'user' });
    await sandbox.files.write(`${directory}/main.go`, 'package main\nimport ("fmt"; "runtime")\nfunc main() { fmt.Println(runtime.Version()) }\n', { user: 'user' });
    await command(`trust Go ${version} fixture`, `mise trust ${quote(`${directory}/mise.toml`)}`);
  }
  const verifyGo = async (version) => {
    const cwd = `${root}/go-${version}`;
    const actual = await command(`Go ${version} compile and execute`, 'GOTOOLCHAIN=local GOMAXPROCS=1 mise exec -- go run -p=1 .', cwd);
    assert.equal(actual, `go${version}`);
    const environment = JSON.parse(await command(`Go ${version} selected environment`, 'GOTOOLCHAIN=local mise exec -- go env -json GOROOT GOTOOLCHAIN', cwd));
    assert.equal(environment.GOTOOLCHAIN, 'local');
    assert.equal(environment.GOROOT, `/home/user/.local/share/mise/installs/go/${version}`);
  };
  // The first two repositories compile concurrently in the same VM. allSettled
  // ensures neither process is abandoned if the other repository fails.
  const concurrent = await Promise.allSettled(manifest.go.slice(0, 2).map(verifyGo));
  for (const result of concurrent) if (result.status === 'rejected') throw result.reason;
  for (const version of manifest.go.slice(2)) await verifyGo(version);
  await command('installed mise toolchains', 'mise ls --installed', '/home/user');
  assert.equal(await command('default Go', 'GOTOOLCHAIN=local go version', '/home/user'), `go version go${manifest.defaults.go} linux/amd64`);

  for (const version of manifest.node) {
    assert.equal(await command(`Node ${version}`, `mise exec ${quote(`node@${version}`)} -- node --version`, '/home/user'), `v${version}`);
  }
  for (const version of manifest.python) {
    const actual = await command(`Python ${version}`, `uv run --offline --no-project --python ${quote(version)} python -c 'import platform; print(platform.python_version())'`, '/home/user');
    assert.equal(actual, version);
  }
  for (const executable of ['python', 'python3']) {
    assert.equal(await command(`default ${executable}`, `${executable} -c 'import platform; print(platform.python_version())'`, '/home/user'), manifest.defaults.python);
  }
  assert.equal(await command('global uv Python pin', "uv run --offline --no-project python -c 'import platform; print(platform.python_version())'", '/home/user'), manifest.defaults.python);
  const webDirectory = `${root}/web`;
  const projectNode = manifest.node.find((version) => version !== manifest.defaults.node) ?? manifest.defaults.node;
  await sandbox.files.write(`${webDirectory}/mise.toml`, `[tools]\nnode = "${projectNode}"\n`, { user: 'user' });
  await sandbox.files.write(`${webDirectory}/package.json`, '{"name":"template-verification","private":true}\n', { user: 'user' });
  await command('trust web fixture', `mise trust ${quote(`${webDirectory}/mise.toml`)}`);
  assert.equal(await command('repository Node override', 'mise exec -- node --version', webDirectory), `v${projectNode}`);
  assert.equal(await command('pnpm in repository Node override', 'mise exec -- pnpm --version', webDirectory), manifest.pnpm);
  assert.equal(await command('pnpm subprocess uses repository Node', 'mise exec -- pnpm exec node --version', webDirectory), `v${projectNode}`);
  assert.equal(await command('isolated Codex Node', 'mise exec -- /opt/codex-runtime/bin/node --version', webDirectory), `v${manifest.defaults.node}`);
  const sdkScript = `const root='/home/user/.codex-web/runtime/node_modules/@openai/codex-sdk'; const pkg=require(root+'/package.json'); if(pkg.version!==${JSON.stringify(manifest.codexSdk)}) throw Error('SDK version mismatch'); import(root+'/dist/index.js').then(m=>{if(typeof m.Codex!=='function')throw Error('Codex export unavailable'); console.log(pkg.version)})`;
  assert.equal(await command('preinstalled Codex SDK with isolated Node', `mise exec -- /opt/codex-runtime/bin/node -e ${quote(sdkScript)}`, webDirectory), manifest.codexSdk);
  assert.equal(await command('pnpm', 'pnpm --version', '/home/user'), manifest.pnpm);
  await command('Go installed sizes in KiB', `du -k -s ${manifest.go.map((version) => quote(`/home/user/.local/share/mise/installs/go/${version}`)).join(' ')}`, '/home/user');
  await command('toolchain totals in KiB', 'du -k -s /home/user/.local/share/mise/installs/go /home/user/.local/share/mise/installs/node /home/user/.local/share/uv/python /opt/codex-runtime', '/home/user');
  report.passed = true;
  delete report.activeCheck;
} catch (error) {
  // Avoid dumping SDK error objects, which may contain connection credentials.
  failed = true;
  if (error instanceof assert.AssertionError) report.assertionFailure = error.message;
  console.error('Template verification failed; inspect the completed checks in the report.');
} finally {
  if (sandbox) {
    try {
      await sandbox.kill({ requestTimeoutMs: 10_000 });
      report.deleted = true;
      console.log(`Deleted verification sandbox: ${sandbox.sandboxId}`);
    } catch {
      failed = true;
      console.error(`Could not delete verification sandbox ${sandbox.sandboxId}; manual cleanup is required.`);
    }
  }
  report.finishedAt = new Date().toISOString();
  const reportDirectory = paths.output;
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, 'template-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
}
if (failed) process.exitCode = 1;
