import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

const PREFIX = '--cocell-working-directory=';
const supported = tool => ['git', 'glab', 'cocell_git', 'cocell_glab'].includes(tool);
function validate(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path ||
      path.length > 4096 || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char.charCodeAt(0) === 92))
    throw new Error('Invalid tool working directory');
  return path;
}

// Cellbox carries argv but not the invoking process's cwd.
export function encodeWorkingDirectory(tool, args, cwd) {
  return supported(tool) ? [PREFIX + validate(cwd), ...args] : args;
}

export async function decodeWorkingDirectory(tool, inputArgs, agentHome = '/home/agent') {
  if (!supported(tool) || !inputArgs[0]?.startsWith(PREFIX)) return { args: inputArgs };
  const requested = validate(inputArgs[0].slice(PREFIX.length));
  const root = await realpath(agentHome);
  const cwd = await realpath(requested);
  const path = relative(root, cwd);
  if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path) || !(await stat(cwd)).isDirectory())
    throw new Error('Tool working directory is outside the agent HOME');
  // The protected CLI runs as debug while the repository belongs to agent.
  // Trust only this invocation's repository, never all repositories globally.
  let repository = cwd;
  for (let directory = cwd; ; directory = dirname(directory)) {
    try { await stat(join(directory, '.git')); repository = directory; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (directory === root) break;
  }
  return { args: inputArgs.slice(1), cwd, gitEnv: {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: repository,
  } };
}
