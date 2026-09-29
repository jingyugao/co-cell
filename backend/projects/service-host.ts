import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ServiceTarget { projectId: string; port: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = /^p([0-9a-f]{32})([0-9a-f]{4})([0-9a-f]{12})$/;

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`cocell-service-host-v1\0${payload}`).digest('hex').slice(0, 12);
}

export function serviceHost(projectId: string, port: number, publicUrl: string, secret: string): string {
  if (!UUID.test(projectId) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service target');
  const payload = projectId.toLowerCase().replaceAll('-', '') + port.toString(16).padStart(4, '0');
  return `p${payload}${signature(payload, secret)}.${new URL(publicUrl).host}`;
}

export function parseServiceHost(host: string, publicUrl: string, secret: string): ServiceTarget | null {
  const suffix = `.${new URL(publicUrl).host.toLowerCase()}`;
  const normalized = host.toLowerCase();
  if (!normalized.endsWith(suffix)) return null;
  const label = normalized.slice(0, -suffix.length);
  const match = LABEL.exec(label);
  if (!match) return null;
  const payload = match[1] + match[2];
  const expected = signature(payload, secret);
  if (!timingSafeEqual(Buffer.from(match[3]), Buffer.from(expected))) return null;
  const port = Number.parseInt(match[2], 16);
  if (port < 1 || port > 65535) return null;
  const id = match[1];
  return { projectId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`, port };
}
