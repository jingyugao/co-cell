export type ModelProxyKind = 'new-api' | 'cliproxyapi' | 'litellm';

/** Keep the existing New API retry policy unless another proxy is selected. */
export function modelProxyKind(env: NodeJS.ProcessEnv = process.env): ModelProxyKind {
  const kind = env.CODEX_PROXY_KIND || 'new-api';
  if (kind !== 'new-api' && kind !== 'cliproxyapi' && kind !== 'litellm') {
    throw new Error('CODEX_PROXY_KIND must be new-api, cliproxyapi or litellm');
  }
  if (kind === 'cliproxyapi' || kind === 'litellm') {
    const name = kind === 'litellm' ? 'LiteLLM' : 'CLIProxyAPI';
    if (!env.OPENAI_BASE_URL || !(env.CODEX_API_KEY || env.OPENAI_API_KEY)) {
      throw new Error(`${name} needs OPENAI_BASE_URL and its client access key in CODEX_API_KEY`);
    }
    let url: URL;
    try { url = new URL(env.OPENAI_BASE_URL); }
    catch { throw new Error(`${name} OPENAI_BASE_URL must be an HTTP(S) base URL`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${name} OPENAI_BASE_URL must be an HTTP(S) base URL without credentials, query or fragment`);
    }
  }
  return kind;
}
