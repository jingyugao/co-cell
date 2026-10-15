import { test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('requirement lookup uses managed credentials and handles Meegle auth exit codes', async () => {
  await promisify(execFile)('pnpm', ['exec', 'tsx', '--test', 'backend/projects/requirements.test.ts', 'backend/execution/system-tools.test.ts', 'backend/secrets/home-reference.test.ts'], { timeout: 20_000 });
});
