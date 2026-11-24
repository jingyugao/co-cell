// Install at image build time. System hooks are trusted by the headless Codex App Server.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const config = '/home/agent/.cocell-hindsight.json';
for (const [settings, entry] of [
  ['/etc/codex/hooks.json', 'codex-stop-hook.js'],
  ['/etc/claude-code/managed-settings.json', 'claude-stop-hook.js'],
]) {
  const script = '/opt/product/cocell/hindsight/dist/' + entry;
  await access(script);
  const raw = await readFile(settings, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '{}';
  });
  const value = JSON.parse(raw);
  const hooks = (value.hooks ??= {});
  const stops = (hooks.Stop ??= []);
  // Fail closed even if the config disappears while the official hook is starting.
  const command = `if test -r ${config}; then HINDSIGHT_DISABLED=true HINDSIGHT_CONFIG=${config} exec /usr/local/bin/node ${script}; fi`;
  if (!stops.some(group => group.hooks?.some(hook => hook.command === command))) {
    stops.push({ hooks: [{ type: 'command', command, timeout: 60 }] });
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify(value) + '\n', { mode: 0o644 });
  }
}
