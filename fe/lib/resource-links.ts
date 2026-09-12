/** Link resolution is contextual; the server remains responsible for realpath and access checks. */
export type ResourceContext = {
  projectId?: string;
  workingDirectory?: string;
  /** Directory of the document being previewed, for its relative links. */
  baseDirectory?: string;
};

export type ResourceLink =
  | { kind: 'file'; path: string; line?: number; fragment?: string }
  | { kind: 'service'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; href: string };

const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);
const localAddress = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{1,5}(?:[/?#]|$)/i;
const documentExtensions = /\.(?:md|mdx|txt|go|js|jsx|ts|tsx|mjs|cjs|json|yaml|yml|toml|xml|html|htm|css|scss|less|py|php|sh|bash|zsh|sql|rs|java|c|h|cc|cpp|hpp|cs|rb|vue|svelte|proto|lock|log|csv|tsv|pdf|png|jpe?g|gif|webp|svg|ico|zip|gz|tar|wasm|ipynb)$/i;
// A deliberately conservative domain heuristic. Explicit schemes always take precedence.
const domainTlds = new Set(['com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'ai', 'app', 'dev', 'site', 'cn', 'uk', 'de', 'fr', 'jp', 'us', 'co', 'me', 'info', 'biz', 'xyz', 'tech', 'cloud', 'online', 'store', 'tv']);
const sharedDocs = '/home/user/.codex/docs';

function absolutePath(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || /[\x00-\x1f\x7f\\]/.test(value)) return null;
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return '/' + parts.join('/');
}

function within(path: string, directory: string): boolean {
  return directory === '/' || path === directory || path.startsWith(directory + '/');
}

function looksLikeDomain(value: string): boolean {
  const authority = value.split(/[/?#]/, 1)[0];
  const host = authority.replace(/:\d{1,5}$/, '');
  const labels = host.toLowerCase().split('.');
  if (labels[0] !== 'www' && documentExtensions.test(host)) return false;
  return labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    && (labels[0] === 'www' || domainTlds.has(labels.at(-1)!));
}

function webResource(href: string, projectId?: string): ResourceLink | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!localHosts.has(url.hostname)) return { kind: 'external', href };
    if (!projectId || url.port === '0' || url.username || url.password) return null;
    return { kind: 'service', href: url.href };
  } catch { return null; }
}

/** Resolve an individual Markdown link, never arbitrary prose or a code block. */
export function resolveResource(href: string, context: ResourceContext): ResourceLink | null {
  const input = href.trim();
  if (!input || /[\x00-\x1f\x7f]/.test(input)) return null;
  if (input.startsWith('#')) return { kind: 'anchor', href: input };
  if (/^https?:\/\//i.test(input)) return webResource(input, context.projectId);
  if (input.startsWith('//')) return webResource('https:' + input, context.projectId);
  if (localAddress.test(input)) return webResource('http://' + input, context.projectId);
  if (/^(mailto|tel):/i.test(input)) return { kind: 'external', href: input };
  if (looksLikeDomain(input)) return webResource('https://' + input, context.projectId);

  if (!context.projectId) return null;
  const workingDirectory = context.workingDirectory ? absolutePath(context.workingDirectory) : null;
  let pathInput = input;
  let explicitFile = false;
  if (/^sandbox:/i.test(input)) {
    // No authority is accepted: project ownership comes from the message, never the link.
    const service = /^sandbox:\/ports\/(\d{1,5})([/?#].*)?$/i.exec(input);
    if (service) return webResource(`http://localhost:${service[1]}${service[2] || '/'}`, context.projectId);
    const file = /^sandbox:\/files\/(.*)$/i.exec(input);
    if (!file || !workingDirectory) return null;
    pathInput = `${workingDirectory}/${file[1]}`;
    explicitFile = true;
  } else if (/^file:/i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hostname && url.hostname !== 'localhost') return null;
      pathInput = url.pathname + url.search + url.hash;
      explicitFile = true;
    } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(input)
    && !(documentExtensions.test(input.split(':', 1)[0]) && /:\d+(?::\d+)?(?:[?#].*)?$/.test(input))) {
    return null;
  }

  const hashIndex = pathInput.indexOf('#');
  const rawFragment = hashIndex < 0 ? undefined : pathInput.slice(hashIndex + 1);
  let rawPath = (hashIndex < 0 ? pathInput : pathInput.slice(0, hashIndex)).split('?', 1)[0];
  let line: number | undefined;
  const suffix = /:(\d+)(?::\d+)?$/.exec(rawPath);
  if (suffix) { line = Number(suffix[1]); rawPath = rawPath.slice(0, suffix.index); }
  let decodedPath: string;
  let fragment: string | undefined;
  try {
    decodedPath = decodeURIComponent(rawPath);
    fragment = rawFragment === undefined ? undefined : decodeURIComponent(rawFragment);
  } catch { return null; }
  const lineAnchor = fragment && /^L(\d+)(?:C\d+|(?:-L?\d+))?$/i.exec(fragment);
  if (lineAnchor) line = Number(lineAnchor[1]);
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null;

  if (!decodedPath.startsWith('/')) {
    const base = context.baseDirectory ? absolutePath(context.baseDirectory) : workingDirectory;
    if (!base || (!explicitFile && !context.baseDirectory && !/^\.{1,2}\//.test(decodedPath) && !documentExtensions.test(decodedPath))) return null;
    // In a chat, a bare phrase ending in an extension is not enough evidence of a path.
    // Explicit ./ paths, document-relative links and percent-encoded filenames remain supported.
    if (!context.baseDirectory && !/^\.{1,2}\//.test(rawPath) && /\s/.test(rawPath)) return null;
    decodedPath = `${base}/${decodedPath}`;
  }
  const path = absolutePath(decodedPath);
  if (!path || !((workingDirectory && within(path, workingDirectory)) || within(path, sharedDocs))) return null;
  return { kind: 'file', path, ...(line === undefined ? {} : { line }), ...(fragment === undefined ? {} : { fragment }) };
}

export function fileViewUrl(projectId: string, path: string, line?: number, fragment?: string): string {
  const query = new URLSearchParams({ path });
  if (line !== undefined) query.set('line', String(line));
  return `/projects/${encodeURIComponent(projectId)}/files?${query}${fragment ? '#' + encodeURIComponent(fragment) : ''}`;
}

export function fileContentUrl(projectId: string, path: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path, raw: '1' })}`;
}
