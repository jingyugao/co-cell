/** Public installation resources; never include application or API responses. */
export const PUBLIC_PWA_ASSETS: Record<string, { file: string; contentType: string }> = {
  '/manifest.webmanifest': { file: 'manifest.webmanifest', contentType: 'application/manifest+json' },
  '/sw.js': { file: 'sw.js', contentType: 'text/javascript; charset=utf-8' },
  '/offline.html': { file: 'offline.html', contentType: 'text/html; charset=utf-8' },
  '/icons/icon.svg': { file: 'icons/icon.svg', contentType: 'image/svg+xml' },
  '/icons/icon-192.png': { file: 'icons/icon-192.png', contentType: 'image/png' },
  '/icons/icon-512.png': { file: 'icons/icon-512.png', contentType: 'image/png' },
  '/icons/apple-touch-icon.png': { file: 'icons/apple-touch-icon.png', contentType: 'image/png' },
};

export function isPublicPwaAsset(path: string, method: string): boolean {
  return ['GET', 'HEAD'].includes(method) && Object.hasOwn(PUBLIC_PWA_ASSETS, path);
}
