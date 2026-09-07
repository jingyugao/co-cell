import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Web builds use immutable per-job inputs/reports; the CLI keeps its defaults.
export function templatePaths() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, output: { type: 'string' }, alias: { type: 'string' } }, allowPositionals: false });
  if (values.alias && !/^[a-z][a-z0-9-]{0,63}$/.test(values.alias)) throw new Error('Invalid template alias');
  return {
    manifest: resolve(values.manifest ?? fileURLToPath(new URL('toolchains.json', import.meta.url))),
    output: resolve(values.output ?? fileURLToPath(new URL('../../data/e2b/', import.meta.url))),
    alias: values.alias,
  };
}
