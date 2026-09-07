import { spawn } from 'node:child_process';
import { createDeveloperReadonlyManifests } from './kubernetes-policy.js';

// Explicit administrator CLI only. Web imports/turns never alter cluster RBAC.
const contexts = process.argv.slice(2);
if (!contexts.length || contexts.some(context => !context || context.startsWith('-') || /[\r\n\0]/.test(context))) {
  console.error('用法：pnpm kubernetes:configure common example_data example_extra'); process.exit(1);
}
const run = (args: string[], input?: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn('kubectl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; const timer = setTimeout(() => child.kill(), 30_000);
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) child.kill(); });
  child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(input ?? '');
  child.on('error', () => { clearTimeout(timer); reject(Error('kubectl 未能启动')); });
  child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(Error('RBAC 配置失败，请检查宿主集群管理权限')); });
});
try {
  const manifests = createDeveloperReadonlyManifests();
  // Reject pre-existing unmanaged objects with these names. The first deployment
  // from this task used the exact same public manifest without an ownership label.
  for (const context of contexts) {
    for (const item of manifests) {
      const scope = 'namespace' in item.metadata ? ['--namespace', item.metadata.namespace] : [];
      const existing = await run(['--context', context, '--request-timeout=15s', 'get', item.kind.toLowerCase(), item.metadata.name, ...scope, '--ignore-not-found', '-o', 'json']);
      if (!existing.trim()) continue;
      const current = JSON.parse(existing);
      const applied = current.metadata?.annotations?.['kubectl.kubernetes.io/last-applied-configuration'];
      if (current.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'swarm-hive') {
        const previous = applied ? JSON.parse(applied) : {};
        // Re-run the exact generated document to adopt the original deployment.
        const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
        if (previous.metadata?.annotations && !Object.keys(previous.metadata.annotations).length) delete previous.metadata.annotations;
        if (canonical(previous) !== canonical(item)) throw Error('发现同名非托管 RBAC 资源，请先人工核对');
      }
    }
    const items = manifests.map(item => ({ ...item, metadata: { ...item.metadata, labels: { 'app.kubernetes.io/managed-by': 'swarm-hive' } } }));
    await run(['--context', context, '--request-timeout=20s', 'apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
    console.log(`${context}: 开发者只读 RBAC 已配置`);
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'RBAC 配置失败'); process.exitCode = 1; }
