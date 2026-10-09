import { test as base, expect } from '@playwright/test';
import { LiveEnvironment, liveConfig } from './environment.mjs';
import { startBrowserProxy } from './proxy.mjs';

export const test = base.extend({
  environment: [async ({}, use, testInfo) => {
    const environment = new LiveEnvironment(liveConfig({ ...process.env,
      COCELL_E2E_BASE_URL: process.env.COCELL_E2E_API_A_URL ?? process.env.COCELL_E2E_BASE_URL }), {
      journal: testInfo.outputPath('resources.json'), step: (name, run) => base.step(name, run),
    });
    await environment.persist();
    try {
      expect((await environment.json('/api/config')).sandbox?.enabled).toBe(true);
      await use(environment);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) await environment.captureFailure();
      try { await environment.cleanup(); }
      finally {
        try { await Promise.all(environment.transports.map(transport => transport.close())); }
        finally { await testInfo.attach('lifecycle-evidence', { path: environment.journal, contentType: 'application/json' }); }
      }
    }
  }, { timeout: Number(process.env.COCELL_E2E_OPERATION_TIMEOUT_MS ?? 300_000) + 60_000 }],
  livePage: async ({ browser, environment }, use) => {
    const proxy = await startBrowserProxy(environment);
    const context = await browser.newContext({ baseURL: proxy.url, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(environment.redact(error.message)));
    await context.route('**/*', route => new URL(route.request().url()).origin === proxy.url ? route.continue() : route.abort());
    try { await use(page); expect(errors).toEqual([]); }
    finally { await context.close(); await proxy.close(); }
  },
});
export { expect };
