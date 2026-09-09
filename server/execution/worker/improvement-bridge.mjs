import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Runs inside the sandbox. Only the host's persisted receipt completes a tool call. */
export async function startImprovementBridge({ replyDirectory, signal, emit }) {
  const token = randomBytes(32).toString('hex');
  const closed = new AbortController();
  const active = new Set();
  const server = createServer(async (request, response) => {
    const respond = (status, body) => {
      if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }
    };
    if (request.method !== 'POST' || request.url !== '/submit' || request.headers.authorization !== `Bearer ${token}`) {
      respond(403, { ok: false, error: 'Forbidden' }); return;
    }
    const disconnected = new AbortController();
    response.on('close', () => disconnected.abort());
    const waitSignal = AbortSignal.any([signal, closed.signal, disconnected.signal, AbortSignal.timeout(45_000)]);
    let requestId;
    let registered = false;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 131072) throw new Error('建议内容过长');
        chunks.push(chunk);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requestId = parsed.requestId;
      if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid request ID');
      if (active.has(requestId) || active.size >= 20) throw new Error('已有建议正在提交，请稍后重试');
      active.add(requestId);
      registered = true;
      waitSignal.throwIfAborted();
      await emit({ type: 'runtime.improvement_proposal', requestId, input: parsed.input });
      const path = `${replyDirectory}/${requestId}.json`;
      while (true) {
        waitSignal.throwIfAborted();
        let receipt;
        try { receipt = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (receipt) {
          await unlink(path).catch(() => {});
          respond(receipt.ok ? 200 : 400, receipt);
          break;
        }
        await delay(150, undefined, { signal: waitSignal });
      }
    } catch {
      respond(400, { ok: false, error: '未收到数据库保存确认，或提交内容无效；请查看建议页面后再重试。' });
    } finally { if (registered) active.delete(requestId); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    config: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./improvement-mcp.mjs', import.meta.url))],
      env: { SWARM_IMPROVEMENT_URL: `http://127.0.0.1:${server.address().port}/submit`, SWARM_IMPROVEMENT_TOKEN: token },
      enabled: true, required: true, startup_timeout_sec: 10, tool_timeout_sec: 60,
      enabled_tools: ['submit_improvement_proposal', 'submit_optimization'],
    },
    async close() {
      closed.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
