import { gzipSync } from 'node:zlib';
import { signedOssRequest } from '../archives/oss-download.js';
import type { AssetFile } from './github-skill.js';

export function agentOssPublisher() {
  const bucket = process.env.COCELL_AGENT_OSS_BUCKET;
  if (!bucket) return;
  const endpoint = process.env.OSS_ENDPOINT,
    key = process.env.OSS_ACCESS_KEY,
    secret = process.env.OSS_SECRET_KEY;
  if (!endpoint || !key || !secret || !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucket))
    throw Error('Agent OSS 发布配置不完整');
  return async (revision: string, files: AssetFile[]) => {
    const body = gzipSync(
      JSON.stringify({
        version: 1,
        revision,
        files: files.map((f) => ({ path: f.path, executable: f.executable, data: f.bytes.toString('base64') })),
      }),
    );
    const response = await signedOssRequest(
      'PUT',
      bucket,
      'agents/versions/' + revision + '.json.gz',
      process.env.OSS_REGION || 'us-east-1',
      endpoint,
      key,
      secret,
      body,
    );
    await response.body?.cancel();
    if (!response.ok) throw Error('Agent 配置发布到 OSS 失败，HTTP ' + response.status);
  };
}
