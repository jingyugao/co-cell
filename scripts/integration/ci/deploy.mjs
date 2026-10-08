import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

assert(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux', 'Only deploy on a disposable GitHub Linux runner');
assert(process.env.CODEX_API_KEY && process.env.COCELL_E2E_MODEL, 'Configure the integration model and API key');
const exec = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
const namespace = 'co-cell-ci', context = 'cocell-ci';
const kube = args => ['--context', context, '-n', namespace, ...args];
const nodes = JSON.parse(exec('kubectl', kube(['get', 'nodes', '-o', 'json']))).items;
assert(nodes.length === 1 && nodes[0].metadata.labels['cocell-ci-run'] === process.env.GITHUB_RUN_ID, 'Refusing to deploy to an unrelated cluster');
const nodeName = nodes[0].metadata.name;
const cellbox = process.env.CELLBOX_SOURCE_DIR;
assert(cellbox && process.env.RUNNER_TEMP);
const work = join(process.env.RUNNER_TEMP, 'cocell-ci');
await mkdir(work, { recursive: true, mode: 0o700 });
const credentials = { token: randomBytes(32).toString('hex'), masterKey: randomBytes(32).toString('base64'),
  databasePassword: randomBytes(24).toString('hex'), storagePassword: randomBytes(24).toString('hex') };
for (const value of Object.values(credentials)) console.log('::add-mask::' + value);
await writeFile(join(work, 'credentials.json'), JSON.stringify(credentials), { mode: 0o600 });

// Import images directly into this node; no registry credentials or image pushes.
const suffix = exec('git', ['rev-parse', '--short=12', 'HEAD']).trim();
const images = Object.fromEntries(['web', 'api', 'controller', 'sandbox', 'minio'].map(name => [name, `docker.io/cocell-ci/${name}:${suffix}`]));
const build = args => exec('docker', ['build', ...args], { stdio: 'inherit' });
build(['-f', 'deploy/web/Dockerfile', '-t', images.web, '.']);
build(['-f', join(cellbox, 'images/cellbox-api.Dockerfile'), '-t', images.api, join(cellbox, 'dist/release')]);
build(['-f', join(cellbox, 'images/controller.Dockerfile'), '-t', images.controller, join(cellbox, 'dist/release')]);
const sandboxContext = join(work, 'sandbox'); await mkdir(sandboxContext);
await copyFile(join(cellbox, 'dist/release/cellbox-container-agent'), join(sandboxContext, 'cellbox-container-agent'));
await copyFile('deploy/box-wrap/launcher.mjs', join(sandboxContext, 'launcher.mjs'));
const codexVersion = JSON.parse(await readFile('package.json', 'utf8')).dependencies['@openai/codex'];
build(['-f', join(process.cwd(), 'deploy/ci/Sandbox.Dockerfile'), '--build-arg', `CODEX_VERSION=${codexVersion}`, '-t', images.sandbox, sandboxContext]);
// The old public MinIO image is no longer pullable. Build its pinned official
// source instead of depending on an unverified image mirror.
const minioCommit = '0d7408fc9969caf07de6a8c3a84f9fbb10a6739e';
const minioContext = join(work, 'minio'); await mkdir(minioContext);
exec('go', ['install', `github.com/minio/minio@${minioCommit}`], {
  env: { ...process.env, GOBIN: minioContext, CGO_ENABLED: '0' }, stdio: 'inherit',
});
build(['-f', join(process.cwd(), 'deploy/ci/Minio.Dockerfile'), '-t', images.minio, minioContext]);
for (const image of Object.values(images)) {
  exec('bash', ['-o', 'pipefail', '-c', 'docker save "$1" | sudo k3s ctr images import -', 'image-import', image], { stdio: 'inherit' });
}
const imported = exec('sudo', ['k3s', 'ctr', 'images', 'ls']);
const row = imported.split('\n').find(line => line.split(/\s+/)[0] === images.sandbox);
const digest = row?.split(/\s+/)[2]; assert(/^sha256:[a-f0-9]{64}$/.test(digest ?? ''), 'Cannot resolve imported Sandbox manifest');
const sandboxImage = `docker.io/cocell-ci/sandbox@${digest}`;
exec('sudo', ['k3s', 'ctr', 'images', 'tag', images.sandbox, sandboxImage]);

exec('kubectl', ['--context', context, 'create', 'namespace', namespace]);
function apply(items) {
  exec('kubectl', kube(['apply', '-f', '-']), { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }), stdio: ['pipe', 'inherit', 'inherit'] });
}
const secret = (name, stringData) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type: 'Opaque', stringData });
apply([
  secret('ci-infra', { MYSQL_ROOT_PASSWORD: credentials.databasePassword, MYSQL_ROOT_HOST: '%', MYSQL_DATABASE: 'cocell', MINIO_ROOT_USER: 'cocell-ci', MINIO_ROOT_PASSWORD: credentials.storagePassword }),
  secret('ci-storage', { OSS_ACCESS_KEY: 'cocell-ci', OSS_SECRET_KEY: credentials.storagePassword }),
  secret('co-cell-runtime', { COCELL_ACCESS_TOKEN: credentials.token, COCELL_SECRET_MASTER_KEY: credentials.masterKey,
    MYSQL_URL: `mysql://root:${credentials.databasePassword}@mysql:3306/cocell`, CODEX_API_KEY: process.env.CODEX_API_KEY }),
]);
function service(name, port) {
  return { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace }, spec: { selector: { app: name }, ports: [{ port, targetPort: port }] } };
}
function deployment(name, image, port, extra) {
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace }, spec: { replicas: 1,
    selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: {
      containers: [{ name, image, ports: [{ containerPort: port }], envFrom: [{ secretRef: { name: 'ci-infra' } }],
        volumeMounts: [{ name: 'data', mountPath: name === 'mysql' ? '/var/lib/mysql' : '/data' }],
        readinessProbe: name === 'mysql' ? { exec: { command: ['sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ping -h 127.0.0.1 --silent'] }, periodSeconds: 3 }
          : { httpGet: { path: '/minio/health/ready', port }, periodSeconds: 3 }, ...extra }],
      volumes: [{ name: 'data', emptyDir: {} }],
    } } } };
}
apply([service('mysql', 3306), deployment('mysql', 'mysql:8.4', 3306, {}),
  service('minio', 9000), deployment('minio', images.minio, 9000, { imagePullPolicy: 'Never', args: ['server', '/data'] })]);
for (const name of ['mysql', 'minio']) exec('kubectl', kube(['rollout', 'status', `deployment/${name}`, '--timeout=5m']), { stdio: 'inherit' });
const forward = spawn('kubectl', kube(['port-forward', 'service/minio', ':9000', '--address=127.0.0.1']), { stdio: ['ignore', 'pipe', 'pipe'] });
forward.stderr.resume();
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MinIO port-forward did not start')), 15000);
    forward.once('error', reject); forward.once('exit', () => reject(new Error('MinIO port-forward exited')));
    forward.stdout.on('data', data => { const match = /127\.0\.0\.1:(\d+)/.exec(String(data)); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  exec('aws', ['--endpoint-url', `http://127.0.0.1:${port}`, 's3api', 'create-bucket', '--bucket', 'cocell-ci'], {
    env: { ...process.env, AWS_ACCESS_KEY_ID: 'cocell-ci', AWS_SECRET_ACCESS_KEY: credentials.storagePassword, AWS_DEFAULT_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true' },
  });
} finally { forward.kill('SIGTERM'); }

const cellboxValues = { api: { image: images.api, imagePullPolicy: 'Never', config: { clientId: 'cocell-ci', startupTimeoutSeconds: 180,
  profiles: [{ id: 'cocell-ci', provider: 'resumable-k8s-pod', image: sandboxImage, namespace, nodeName, cpu: 1, memoryMiB: 1024,
    guest: { workspace: '/home/agent/workspace', agent: { uid: 11000, gid: 11000 }, debug: { uid: 11001, gid: 11001 },
      command: ['/usr/local/bin/node', '/opt/product/cocell/launcher.mjs'], env: {}, tools: [] } }] } },
  controller: { image: images.controller, imagePullPolicy: 'Never', warmPoolSize: 0, criDirectory: '/run/k3s/containerd', criSocket: '/run/k3s/containerd/containerd.sock' },
  objectStorage: { endpoint: `http://minio.${namespace}.svc.cluster.local:9000`, bucket: 'cocell-ci', credentialsSecret: 'ci-storage' },
};
const webValues = { image: { repository: 'docker.io/cocell-ci/web', tag: suffix, pullPolicy: 'Never' }, existingSecret: 'co-cell-runtime',
  cellbox: { apiUrl: `http://cellbox-api.${namespace}.svc.cluster.local:8090`, clientId: 'cocell-ci', profile: 'cocell-ci' },
  publicUrl: 'http://127.0.0.1:3001', config: { codexModel: process.env.COCELL_E2E_MODEL, openaiBaseUrl: process.env.OPENAI_BASE_URL ?? '',
    codexModelMetadata: JSON.parse(process.env.CODEX_MODEL_METADATA_JSON || '{}') },
  persistence: { size: '1Gi' },
};
const checkDirectory = await mkdtemp(join(cellbox, '.cocell-config-check-'));
try {
  const check = join(checkDirectory, 'main.go');
  await copyFile('scripts/integration/ci/check-cellbox-config.go', check);
  exec('go', ['run', '-buildvcs=false', check], { cwd: cellbox, input: JSON.stringify(cellboxValues.api.config), stdio: ['pipe', 'inherit', 'inherit'] });
} finally { await rm(checkDirectory, { recursive: true, force: true }); }
for (const [name, chart, values] of [['cellbox', join(cellbox, 'charts/cellbox'), cellboxValues], ['co-cell', 'deploy/helm/co-cell', webValues]]) {
  const file = join(work, `${name}-values.json`); await writeFile(file, JSON.stringify(values), { mode: 0o600 });
  exec('helm', ['upgrade', '--install', name, chart, '--kube-context', context, '-n', namespace, '-f', file, '--wait', '--timeout', '5m'], { stdio: 'inherit' });
}
// Keep the provenance, not configuration or credentials, in the uploaded report.
await mkdir('tmp/integration/ci', { recursive: true });
await writeFile('tmp/integration/ci/deployment.json', JSON.stringify({ commit: exec('git', ['rev-parse', 'HEAD']).trim(),
  cellboxCommit: exec('git', ['-C', cellbox, 'rev-parse', 'HEAD']).trim(), minioCommit, nodeName, images, sandboxImage }, null, 2));
