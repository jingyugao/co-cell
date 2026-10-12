import { test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('real App Server readiness verifies live RPCs and reuses the connection', async () => {
  await promisify(execFile)('pnpm', ['exec', 'tsx', '--test', 'backend/execution/app-server-readiness.native.test.ts'], { timeout: 20_000 });
});
