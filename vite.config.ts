import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'node:path';

export default defineConfig({
  optimizeDeps: { exclude: ['@zrimo/viewer', '@silurus/ooxml'] },
  plugins: [react(), viteStaticCopy({ targets: [
    { src: 'node_modules/@zrimo/viewer/dist/{assets,fonts,workers}/**/*', dest: 'vendor/zrimo', rename: { stripBase: 4 } },
  ] }), {
    name: 'page-load-entry',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const entry = context.bundle && Object.values(context.bundle).find(chunk =>
          chunk.type === 'chunk' && chunk.facadeModuleId === resolve(import.meta.dirname, 'fe/page-load.ts'));
        return [{ tag: 'script', attrs: { type: 'module', async: true,
          src: entry ? `/${entry.fileName}` : '/fe/page-load.ts' }, injectTo: 'head-prepend' }];
      },
    },
  }],
  server: {
    host: '127.0.0.1',
    watch: { ignored: [resolve(import.meta.dirname, 'tmp')] },
    fs: { deny: ['.env', '.env.*', '**/.git/**', '**/.codex-web/**', '**/*.{crt,pem}'] },
  },
  build: { outDir: 'dist', rolldownOptions: { input: {
    index: resolve(import.meta.dirname, 'index.html'),
    pageLoad: resolve(import.meta.dirname, 'fe/page-load.ts'),
  } } },
});
