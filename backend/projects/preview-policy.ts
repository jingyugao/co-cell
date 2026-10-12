/** Platform credentials must never reach an application or be set by one. */
export function isPlatformCookie(name: string): boolean {
  return /^(?:(?:__host-|__secure-))?cocell_/i.test(name.trim());
}

export function applicationCookies(raw: string | undefined | null): string | undefined {
  const values = (raw ?? '').split(';').map(value => value.trim())
    .filter(value => value.includes('=') && !isPlatformCookie(value.split('=', 1)[0]));
  return values.length ? values.join('; ') : undefined;
}

export function applicationSetCookie(cookie: string): string | undefined {
  const parts = cookie.split(';').map(part => part.trim());
  if (!parts[0].includes('=') || isPlatformCookie(parts[0].split('=', 1)[0])) return undefined;
  return parts.filter((part, index) => index === 0 || !/^domain\s*=/i.test(part)).join('; ');
}

export function previewLocation(location: string, port: number, path: string, prefix = ''): string {
  try {
    const target = new URL(location, `http://localhost:${port}${path}`);
    if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(target.hostname) &&
      Number(target.port || (target.protocol === 'https:' ? 443 : 80)) === port)
      return `${prefix}${target.pathname}${target.search}${target.hash}`;
  } catch { /* Pass through external or invalid application locations. */ }
  return location;
}
