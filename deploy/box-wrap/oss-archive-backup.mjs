#!/usr/local/bin/node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';

const usage = 'usage: cocell-archive-backup --endpoint ENDPOINT --bucket BUCKET --region REGION --prefix PREFIX OBJECT_KEY_SUFFIX';
const args = process.argv.slice(2);
if (args.length !== 9 || args[0] !== '--endpoint' || args[2] !== '--bucket' || args[4] !== '--region' || args[6] !== '--prefix'
    || !/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(args[1]) || !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(args[3])
    || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(args[5])
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(args[8]) || args[8].includes('..')) {
  console.error(usage);
  process.exit(2);
}

const endpoint = args[1];
const bucket = args[3];
const region = args[5];
const prefix = args[7].replace(/^\/+|\/+$/g, '');
const objectSuffix = args[8];
const accessFile = process.env.AWS_ACCESS_KEY_ID;
const secretFile = process.env.AWS_SECRET_ACCESS_KEY;
if (!endpoint || !bucket || !accessFile || !secretFile) throw new Error('OSS tool configuration is incomplete');
const accessKey = (await readFile(accessFile, 'utf8')).trim();
const secretKey = (await readFile(secretFile, 'utf8')).trim();
if (!accessKey || !secretKey) throw new Error('OSS credential slot is empty');
const objectKey = [prefix, objectSuffix].filter(Boolean).join('/');
const workspace = process.env.COCELL_ARCHIVE_SOURCE || '/home/agent/workspace';
const tempRoot = join('/tmp', `cocell-archive-${randomUUID()}`);
const archivePath = join(tempRoot, 'archive.tar.gz');

const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const sha256 = value => createHash('sha256').update(value).digest('hex');
function signingKey(date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), service), 'aws4_request');
}
function signedRequest(method, path, body, contentType = 'application/octet-stream') {
  const url = new URL(endpoint);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '').replace('Z', 'Z');
  const date = amzDate.slice(0, 8);
  const service = 's3';
  const payloadHash = body?.sha256 ?? sha256('');
  const host = url.host;
  const canonicalUri = `/${encodeURIComponent(bucket).replace(/%2F/g, '/')}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { host, 'content-length': String(body?.size ?? 0), 'content-type': contentType, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(key => `${key}:${headers[key]}\n`).join('');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const canonical = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey(date, region, service), stringToSign, 'hex')}`;
  const transport = url.protocol === 'https:' ? httpsRequest : request;
  return new Promise((resolve, reject) => {
    const req = transport({ hostname: url.hostname, port: url.port || undefined, method, path: canonicalUri, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) reject(new Error(`OSS upload failed with HTTP ${response.statusCode}`));
        else resolve({ etag: response.headers.etag?.replaceAll('"', '') ?? null });
      });
    });
    req.on('error', reject);
    if (body) createReadStream(body.path).pipe(req); else req.end();
  });
}

async function createArchive() {
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/tar', ['-czf', archivePath, '--', '.'], { cwd: workspace, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`archive command failed: ${stderr.trim() || code}`)));
  });
  const info = await stat(archivePath);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
  return { path: archivePath, size: info.size, sha256: hash.digest('hex') };
}

try {
  const archive = await createArchive();
  const uploaded = await signedRequest('PUT', objectKey, archive);
  console.log(JSON.stringify({ version: 1, provider: 'oss', storageType: 'oss', format: 'tar-gz-v1', bucket, region, objectKey, sizeBytes: archive.size, sha256: archive.sha256, etag: uploaded.etag, workspace, createdAt: new Date().toISOString() }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
