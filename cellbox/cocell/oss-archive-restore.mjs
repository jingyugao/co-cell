#!/usr/local/bin/node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';

const [raw, endpoint] = process.argv.slice(2);
if (!raw || raw.length > 8192) throw new Error('archive metadata argument is required');
const meta = JSON.parse(raw);
// Archives created before region was included in metadata used us-east-1.
const region = meta?.region === undefined ? 'us-east-1' : meta.region;
if (meta?.version !== 1 || meta?.storageType !== 'oss' || typeof meta.objectKey !== 'string' ||
    typeof meta.bucket !== 'string' || typeof region !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(meta.bucket) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(region) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(meta.objectKey) || meta.objectKey.includes('..')) throw new Error('invalid archive metadata');
const accessFile = process.env.AWS_ACCESS_KEY_ID;
const secretFile = process.env.AWS_SECRET_ACCESS_KEY;
if (!endpoint || !accessFile || !secretFile) throw new Error('OSS tool configuration is incomplete');
const accessKey = (await readFile(accessFile, 'utf8')).trim();
const secretKey = (await readFile(secretFile, 'utf8')).trim();
if (!accessKey || !secretKey) throw new Error('OSS credential slot is empty');
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const signingKey = (date, region) => hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), 's3'), 'aws4_request');
const tempRoot = join('/tmp', `cocell-archive-restore-${randomUUID()}`);
const archivePath = join(tempRoot, 'archive.tar.gz');
async function download() {
  const url = new URL(endpoint); const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '').replace('Z', 'Z'); const date = amzDate.slice(0, 8);
  const uri = `/${encodeURIComponent(meta.bucket)}/${meta.objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { host: url.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort().join(';'); const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  const scope = `${date}/${region}/s3/aws4_request`; const canonical = ['GET', uri, '', canonicalHeaders, signed, 'UNSIGNED-PAYLOAD'].join('\n');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${hmac(signingKey(date, region), ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n'), 'hex')}`;
  const transport = url.protocol === 'https:' ? httpsRequest : request;
  await new Promise((resolve, reject) => { const req = transport({ hostname: url.hostname, port: url.port || undefined, path: uri, headers }, res => {
    if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) { res.resume(); reject(new Error(`OSS download failed with HTTP ${res.statusCode}`)); return; }
    const file = createWriteStream(archivePath, { mode: 0o600 }); res.pipe(file); file.on('finish', () => file.close(resolve)); file.on('error', reject);
  }); req.on('error', reject); req.end(); });
}
try {
  await mkdir(tempRoot, { recursive: true, mode: 0o700 }); await download();
  const info = await stat(archivePath); if (info.size !== meta.sizeBytes) throw new Error('archive size mismatch');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
  if (hash.digest('hex') !== meta.sha256) throw new Error('archive checksum mismatch');
  const workspace = await stat('/home/agent/workspace');
  if (!workspace.isDirectory() || workspace.uid === 0 || workspace.gid === 0) throw new Error('workspace is not agent-owned');
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/tar', ['--extract', '--gzip', '--file', archivePath, '--directory', '/home/agent/workspace', '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `restore failed: ${code}`)));
  });
  console.log(JSON.stringify({ ...meta, restored: true }));
} finally { await rm(tempRoot, { recursive: true, force: true }); }
