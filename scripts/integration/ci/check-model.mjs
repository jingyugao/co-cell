import assert from 'node:assert/strict';

const { CODEX_API_KEY: key, COCELL_E2E_MODEL: model, OPENAI_BASE_URL: base } = process.env;
assert(key, 'Set integration secret CODEX_API_KEY');
assert(model, 'Set integration variable or secret COCELL_E2E_MODEL');
const url = new URL('models', `${(base || 'https://api.openai.com/v1').replace(/\/+$/, '')}/`);
assert(['http:', 'https:'].includes(url.protocol), 'Model gateway must use HTTP(S)');
const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
assert(response.ok, `Model gateway authentication/reachability preflight failed: HTTP ${response.status}`);
const result = await response.json();
assert(Array.isArray(result.data), 'Model gateway returned an invalid models list');
assert(result.data.some(entry => entry.id === model), 'Configured integration model is not advertised by this API key; check COCELL_E2E_MODEL and gateway permissions');
console.log('Model gateway is reachable; API key and configured model passed preflight');
