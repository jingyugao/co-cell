import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const data = resolve(root, 'data/e2b');
const source = resolve(root, 'tmp/e2b-infra');
mkdirSync(`${data}/config`, { recursive: true, mode: 0o700 });
for (const dir of ['bin', 'artifacts', 'runtime', 'run', 'volumes', 'templates', 'build-cache', 'sandbox-cache']) {
  mkdirSync(`${data}/${dir}`, { recursive: true });
}
const secretFile = `${data}/config/local-secrets.json`;
const secrets = existsSync(secretFile)
  ? JSON.parse(readFileSync(secretFile, 'utf8'))
  : { edge: randomBytes(32).toString('hex'), sandbox: randomBytes(32).toString('hex') };
writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600 });
const common = {
  ENVIRONMENT: 'local', NODE_ID: 'swarm-hive-e2b-local', NODE_IP: '127.0.0.1',
  REDIS_URL: '127.0.0.1:16379',
  CLICKHOUSE_CONNECTION_STRING: 'clickhouse://clickhouse:clickhouse@127.0.0.1:19000/default',
  CLICKHOUSE_PORT: '19000',
  GOMEMLIMIT: '512MiB', GOMAXPROCS: '2',
  PERSISTENT_VOLUME_MOUNTS: `test-volume-type:${data}/volumes`,
};
const overrides = {
  api: {
    POSTGRES_CONNECTION_STRING: 'postgres://postgres:postgres@127.0.0.1:15432/postgres?sslmode=disable',
    SERVICE_DISCOVERY_PROVIDER: 'local', LOCAL_ORCHESTRATOR_ADDRESS: '127.0.0.1:5008',
    LOCAL_CLUSTER_TOKEN: secrets.edge, SANDBOX_ACCESS_TOKEN_HASH_SEED: secrets.sandbox,
    DB_MAX_OPEN_CONNECTIONS: '10', DB_MIN_IDLE_CONNECTIONS: '1',
    AUTH_DB_MAX_OPEN_CONNECTIONS: '5', AUTH_DB_MIN_IDLE_CONNECTIONS: '1',
    REDIS_POOL_SIZE: '10', LOGS_READ_CONFIG: 'true',
  },
  'client-proxy': {
    EDGE_SECRET: secrets.edge, EDGE_URL: 'http://127.0.0.1:13000',
    PROXY_PORT: '13002', HEALTH_PORT: '13003', REDIS_POOL_SIZE: '10',
  },
  orchestrator: {
    GOMEMLIMIT: '1GiB', NBD_POOL_SIZE: '4',
    E2B_USE_SYNC_WP: 'true',
    TMPDIR: `${data}/run`,
    FIRECRACKER_VERSIONS_DIR: `${data}/artifacts/firecrackers`,
    HOST_BUSYBOX_DIR: `${data}/artifacts/busybox`,
    HOST_KERNELS_DIR: `${data}/artifacts/kernels`, HOST_ENVD_PATH: `${data}/bin/envd`,
    ORCHESTRATOR_BASE_PATH: `${data}/runtime`, ORCHESTRATOR_LOCK_PATH: `${data}/runtime/.lock`,
    SANDBOX_DIR: `${data}/runtime/vms`, SANDBOX_CACHE_DIR: `${data}/sandbox-cache`,
    LOCAL_TEMPLATE_STORAGE_BASE_PATH: `${data}/templates`,
    LOCAL_BUILD_CACHE_STORAGE_BASE_PATH: `${data}/build-cache`,
  },
};
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
for (const [service, extra] of Object.entries(overrides)) {
  const entries = readFileSync(`${source}/packages/${service}/.env.local`, 'utf8')
    .split('\n').filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]);
  const config = { ...Object.fromEntries(entries), ...common, ...extra };
  writeFileSync(`${data}/config/${service}.env`,
    Object.entries(config).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n',
    { mode: 0o600 });
}
console.log('E2B 配置已写入 data/e2b/config，全部运行数据指向 data/e2b。');
