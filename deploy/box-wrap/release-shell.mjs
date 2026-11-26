import { appendFile, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const source = '[ ! -r "$HOME/.cocell-release-path" ] || . "$HOME/.cocell-release-path"';

export async function installReleaseShell(home, root) {
  // This file is read by the agent's login shell after the base image resets PATH.
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, '.cocell-release-path'), temp = file + '-' + randomUUID();
  const literal = "'" + root.replaceAll("'", "'\\''") + "'";
  const script = [
    'COCELL_HARNESS_BIN=' + literal + '/bin',
    'case ":$PATH:" in *":$COCELL_HARNESS_BIN:"*) ;; *) PATH="$COCELL_HARNESS_BIN:' +
      '$COCELL_HARNESS_BIN/../codex/bin:$COCELL_HARNESS_BIN/../codex/codex-path:$COCELL_HARNESS_BIN/../claude:$PATH";; esac',
    'if [ -d /var/lib/cellbox/shared/tools/current/bin ]; then',
    '  case "$PATH" in /var/lib/cellbox/shared/tools/current/bin:*) ;; *) PATH="/var/lib/cellbox/shared/tools/current/bin:$PATH";; esac',
    'fi', 'export PATH COCELL_HARNESS_BIN', '',
  ].join('\n');
  try { await writeFile(temp, script, { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
  // Bash selects the first existing login file. Creating .bash_profile would hide .profile.
  for (const name of ['.profile', '.bash_profile', '.bash_login', '.zlogin']) {
    const path = join(home, name);
    try {
      const previous = await readFile(path, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (previous === undefined && name.startsWith('.bash_')) continue;
      if (!previous?.split('\n').includes(source)) await appendFile(path, '\n' + source + '\n', { mode: 0o600 });
    } catch (error) {
      // An image may supply a read-only login profile. Child shells also inherit PATH and BASH_ENV.
      if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
    }
  }
  if (!process.env.BASH_ENV) process.env.BASH_ENV = file;
}
