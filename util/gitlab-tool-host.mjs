const PREFIX = '--cocell-gitlab-host=';

function validateHost(host) {
  if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?$/.test(host)) {
    throw new Error('Invalid GitLab host');
  }
  return host;
}

// The Cellbox tool transport carries argv, not the caller's environment.
export function encodeGitlabHost(tool, args, host) {
  return ['glab', 'cocell_glab'].includes(tool) && host ? [PREFIX + validateHost(host), ...args] : args;
}

export function decodeGitlabHost(tool, inputArgs) {
  let args = inputArgs, host;
  if (tool !== 'glab') return { args, env: {} };
  if (args[0]?.startsWith(PREFIX)) {
    host = validateHost(args[0].slice(PREFIX.length));
    args = args.slice(1);
  }
  // Older glab releases query the default host's /user even when cloning a URL.
  if (args[0] === 'repo' && args[1] === 'clone' && /^https?:\/\//.test(args[2] ?? '')) {
    host = validateHost(new URL(args[2]).host);
  }
  return { args, env: host ? { GITLAB_HOST: host } : {} };
}
