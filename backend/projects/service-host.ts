import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ServiceTarget { projectId: string; port: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_LABEL = /^p([0-9a-f]{32})([0-9a-f]{4})([0-9a-f]{12})$/;
const SHORT_LABEL = /^p([0-9a-z]{1,4})-([0-9a-f]{12})$/;

function legacySignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`cocell-service-host-v1\0${payload}`).digest('hex').slice(0, 12);
}

function shortSignature(projectId: string, port: number, secret: string): string {
  return createHmac('sha256', secret).update(`cocell-service-host-v2\0${projectId.toLowerCase()}\0${port}`).digest('hex').slice(0, 12);
}

export function serviceHost(projectId: string, port: number, publicUrl: string, secret: string): string {
  if (!UUID.test(projectId) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service target');
  return `p${port.toString(36)}-${shortSignature(projectId, port, secret)}.${new URL(publicUrl).host}`;
}

export function parseServiceHost(host: string, publicUrl: string, secret: string,
  projectIds: Iterable<string> = []): ServiceTarget | null {
  const suffix = `.${new URL(publicUrl).host.toLowerCase()}`;
  const normalized = host.toLowerCase();
  if (!normalized.endsWith(suffix)) return null;
  const label = normalized.slice(0, -suffix.length);
  const long = LONG_LABEL.exec(label);
  if (long) {
    const payload = long[1] + long[2];
    const expected = legacySignature(payload, secret);
    if (!timingSafeEqual(Buffer.from(long[3]), Buffer.from(expected))) return null;
    const port = Number.parseInt(long[2], 16);
    if (port < 1 || port > 65535) return null;
    const id = long[1];
    return { projectId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`, port };
  }
  const short = SHORT_LABEL.exec(label);
  if (!short) return null;
  const port = Number.parseInt(short[1], 36);
  if (port < 1 || port > 65535 || port.toString(36) !== short[1]) return null;
  let result: ServiceTarget | null = null;
  for (const projectId of projectIds) {
    if (!UUID.test(projectId)) continue;
    const expected = shortSignature(projectId, port, secret);
    if (!timingSafeEqual(Buffer.from(short[2]), Buffer.from(expected))) continue;
    if (result) return null;
    result = { projectId, port };
  }
  return result;
}
