import { test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('real App Server routes directly to channels and retains native conversation history', async () => {
  await promisify(execFile)('pnpm', ['exec', 'tsx', '--test', 'backend/models/direct-provider.native.test.ts'], { timeout: 30_000 });
});
