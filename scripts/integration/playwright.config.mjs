import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const profile = process.env.COCELL_E2E_PROFILE ?? 'ui';
const output = resolve(process.env.COCELL_E2E_OUTPUT_DIR ?? 'tmp/integration/latest');
const port = Number(process.env.COCELL_E2E_UI_PORT ?? 3197);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid COCELL_E2E_UI_PORT');
const uiURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: '.',
  outputDir: `${output}/artifacts`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: `${output}/html`, open: 'never' }],
    ['json', { outputFile: `${output}/results.json` }], ['junit', { outputFile: `${output}/junit.xml` }]],
  use: { browserName: 'chromium', serviceWorkers: 'block', actionTimeout: 10_000,
    navigationTimeout: 30_000, screenshot: 'only-on-failure', trace: 'off' },
  projects: [
    { name: 'harness', testMatch: 'support/*.spec.mjs' },
    { name: 'ui-desktop', testMatch: 'ui/*.spec.mjs', use: { baseURL: uiURL, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' } },
    { name: 'ui-mobile', testMatch: 'ui/*.spec.mjs', use: { baseURL: uiURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, trace: 'retain-on-failure' } },
    { name: 'live', testMatch: 'live/*.spec.mjs', timeout: 10 * 60_000 },
    { name: 'model', testMatch: 'model/*.spec.mjs', timeout: 40 * 60_000 },
  ],
  webServer: ['ui', 'full'].includes(profile) ? {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: resolve('.'), wait: { stdout: /Local:.*http:\/\/127\.0\.0\.1:/ }, timeout: 30_000,
  } : undefined,
});
