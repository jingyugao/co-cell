import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadDeployEnv } from '../config/deploy-env.mjs';
import { liveTransport } from './support/kubernetes.mjs';
import { LiveEnvironment, liveConfig } from './support/environment.mjs';

loadDeployEnv();
assert(process.argv[2], 'Usage: pnpm test:integration:cleanup path/to/resources.json');
const journal = resolve(process.argv[2]);
const saved = JSON.parse(await readFile(journal, 'utf8'));
assert(/^[0-9a-f-]{36}$/.test(saved.runId) && saved.prefix === `integration-${saved.runId}`, 'Invalid integration journal');
const transport = await liveTransport(process.env);
try {
  const config = { ...liveConfig({ ...process.env, ...transport.env }), keepProjects: false };
  assert.equal(config.publicURL.origin, saved.target, 'Journal belongs to a different installation');
  const environment = new LiveEnvironment(config, { journal });
  environment.runId = saved.runId; environment.prefix = saved.prefix; environment.report = saved;
  environment.projects = new Map(saved.projects); environment.sessions = new Set(saved.sessions); environment.boxes = new Set(saved.boxes);
  for (const name of environment.projects.values()) assert(name.startsWith(`${saved.prefix} `), 'Journal contains an unowned project');
  await environment.cleanup();
  console.log(`Cleaned integration run ${saved.runId}; journal: ${journal}`);
} finally { await transport.close(); }
