import { createHash, createHmac } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';

const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export async function downloadOssArchive(ref: RemoteArchiveRef, destination: string,
  endpoint = process.env.OSS_ENDPOINT, accessKey = process.env.OSS_ACCESS_KEY, secretKey = process.env.OSS_SECRET_KEY) {
  const meta = ref.metadata;
  const bucket = meta?.bucket;
  const objectKey = meta?.objectKey;
  const region = meta?.region ?? 'us-east-1';
  if (ref.storageType !== 'oss' || typeof bucket !== 'string' || typeof objectKey !== 'string' ||
      typeof region !== 'string' || !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucket) ||
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(region) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(objectKey) || objectKey.includes('..') ||
      ref.id !== `oss:${objectKey}` || !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 1 || !endpoint || !accessKey || !secretKey)
    throw new Error('OSS archive download configuration or metadata is invalid');
  const origin = new URL(endpoint);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash)
    throw new Error('OSS endpoint is invalid');
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const uri = `/${encodeURIComponent(bucket)}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { host: origin.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': now };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(name => `${name}:${headers[name as keyof typeof headers]}\n`).join('');
  const scope = `${date}/${region}/s3/aws4_request`;
  const canonical = ['GET', uri, '', canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n')).digest('hex');
  const response = await fetch(new URL(uri, origin), { headers: {
    ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }, redirect: 'error', signal: AbortSignal.timeout(5 * 60_000) });
  if (response.status !== 200 || !response.body) throw new Error(`OSS archive download failed with HTTP ${response.status}`);
  const file = await open(destination, 'wx', 0o600);
  let complete = false;
  try {
    const reader = response.body.getReader();
    const digest = createHash('sha256');
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ref.sizeBytes) throw new Error('OSS archive size mismatch');
      digest.update(value);
      await file.writeFile(value);
    }
    if (size !== ref.sizeBytes || digest.digest('hex') !== ref.sha256)
      throw new Error('OSS archive integrity check failed');
    complete = true;
  } finally {
    await file.close();
    if (!complete) await rm(destination, { force: true });
  }
}
