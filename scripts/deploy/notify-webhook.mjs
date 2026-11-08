import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
const integer = (name) => {
  const value = required(name);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid integer environment variable ${name}`);
  }
  return Number(value);
};
const matches = (name, pattern) => {
  const value = required(name);
  if (!pattern.test(value)) throw new Error(`Invalid environment variable ${name}`);
  return value;
};

async function main() {
  let url;
  try {
    url = new URL(required('DEPLOY_URL'));
  } catch {
    throw new Error('Invalid deployment webhook URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid deployment webhook URL');
  }
  const secret = required('DEPLOY_SECRET');
  const body = JSON.stringify({
    schemaVersion: 1,
    repository: matches('GITHUB_REPOSITORY', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    ref: 'refs/heads/master',
    sha: matches('SOURCE_SHA', /^[0-9a-f]{40}$/),
    runId: integer('GITHUB_RUN_ID'),
    runNumber: integer('GITHUB_RUN_NUMBER'),
    runAttempt: integer('GITHUB_RUN_ATTEMPT'),
    chartVersion: matches('CHART_VERSION', /^0\.[1-9]\d*\.[1-9]\d*$/),
    chartSHA256: matches('CHART_SHA256', /^[0-9a-f]{64}$/),
    imageDigest: matches('IMAGE_DIGEST', /^sha256:[0-9a-f]{64}$/),
  });
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const deadline = performance.now() + 32 * 60_000;
  let jobId;
  const jobLabel = () => jobId ? ` (job ${jobId})` : '';
  const remaining = () => {
    const milliseconds = Math.floor(deadline - performance.now());
    if (milliseconds <= 0) throw new Error(`Deployment result is unknown after waiting${jobLabel()}; inspect the Job before retrying`);
    return milliseconds;
  };
  const pause = async (milliseconds) => {
    const left = remaining();
    await delay(Math.min(milliseconds, left));
    remaining();
  };
  const request = async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CoCell-Signature-256': signature },
          body,
          signal: AbortSignal.timeout(Math.min(15_000, remaining())),
          redirect: 'error',
        });
      } catch {
        remaining();
        if (attempt === 3) throw new Error(`Deployment request failed after 3 attempts${jobLabel()}`);
        await pause(attempt * 1000);
        continue;
      }
      if (response.ok) {
        let result;
        try {
          result = await response.json();
        } catch {
          throw new Error(`Invalid deployment response${jobLabel()}`);
        }
        const id = result?.jobId;
        if (!((typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)) ||
              (Number.isSafeInteger(id) && id >= 0)) ||
            !['queued', 'running', 'succeeded', 'superseded', 'failed'].includes(result?.phase)) {
          throw new Error(`Invalid deployment response${jobLabel()}`);
        }
        if (jobId && jobId !== String(id)) throw new Error(`Deployment job changed${jobLabel()}`);
        jobId = String(id);
        return result.phase;
      }
      if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
        throw new Error(`Deployment request rejected (HTTP ${response.status})${jobLabel()}`);
      }
      await pause(attempt * 1000);
    }
  };
  let previousPhase;
  while (true) {
    const phase = await request();
    if (phase !== previousPhase) console.log(`Deployment job ${jobId}: ${phase}`);
    if (phase === 'succeeded') return;
    if (phase === 'superseded') { console.log('A newer master commit superseded this deployment.'); return; }
    if (phase === 'failed') throw new Error(`Deployment failed${jobLabel()}`);
    previousPhase = phase;
    await pause(5000);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
