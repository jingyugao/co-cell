import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize, relative, sep } from 'node:path';

const PREFIX = '--cocell-working-directory=';
function validate(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path ||
      path.length > 4096 || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char.charCodeAt(0) === 92))
    throw new Error('Invalid tool working directory');
  return path;
}

// Cellbox carries argv but not the invoking process's cwd.
export function encodeWorkingDirectory(args, cwd) {
  return [PREFIX + validate(cwd), ...args];
}

export async function decodeWorkingDirectory(inputArgs, agentHome = '/home/agent') {
  if (!inputArgs[0]?.startsWith(PREFIX)) return { args: inputArgs };
  const requested = validate(inputArgs[0].slice(PREFIX.length));
  const root = await realpath(agentHome);
  const cwd = await realpath(requested);
  const path = relative(root, cwd);
  if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path) || !(await stat(cwd)).isDirectory())
    throw new Error('Tool working directory is outside the agent HOME');
  return { args: inputArgs.slice(1), cwd };
}
