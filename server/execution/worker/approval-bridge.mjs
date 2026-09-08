import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Wait for the host to persist a user's decision; never infer consent from silence. */
export async function startApprovalBridge({ replyDirectory, signal, emit }) {
  const token = randomBytes(32).toString('hex');
  const closed = new AbortController();
  const active = new Set();
  const server = createServer(async (request, response) => {
    const respond = (status, body) => {
      if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }
    };
    if (request.method !== 'POST' || request.url !== '/request' || request.headers.authorization !== `Bearer ${token}`) {
      respond(403, { ok: false, error: 'Forbidden' }); return;
    }
    const disconnected = new AbortController();
    response.on('close', () => disconnected.abort());
    const waitSignal = AbortSignal.any([signal, closed.signal, disconnected.signal, AbortSignal.timeout(1_850_000)]);
    let requestId, registered = false, received = false;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 131072) throw Error('Request too large');
        chunks.push(chunk);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requestId = parsed.requestId;
      if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw Error('Invalid request ID');
      if (active.has(requestId) || active.size >= 10) throw Error('Too many approval requests');
      active.add(requestId); registered = true;
      waitSignal.throwIfAborted();
      emit({ type: 'runtime.user_approval_request', requestId, input: parsed.input });
      const path = `${replyDirectory}/${requestId}.json`;
      while (true) {
        waitSignal.throwIfAborted();
        let receipt;
        try { receipt = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (receipt) {
          await unlink(path).catch(() => {});
          if (receipt.ok && (receipt.approval?.id !== requestId || !['approved', 'rejected', 'cancelled', 'expired'].includes(receipt.approval?.status))) throw Error('Invalid decision');
          received = true;
          respond(receipt.ok ? 200 : 400, receipt); break;
        }
        await delay(500, undefined, { signal: waitSignal });
      }
    } catch {
      respond(400, { ok: false, error: '未收到有效用户同意（连接中断、取消、超时或请求无效）。不得执行请求中的操作。' });
    } finally {
      if (registered) {
        active.delete(requestId);
        if (!received) emit({ type: 'runtime.user_approval_cancelled', requestId });
      }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    config: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./approval-mcp.mjs', import.meta.url))],
      env: { SWARM_APPROVAL_URL: `http://127.0.0.1:${server.address().port}/request`, SWARM_APPROVAL_TOKEN: token },
      enabled: true, required: true, startup_timeout_sec: 10, tool_timeout_sec: 1900,
      enabled_tools: ['request_user_approval'],
    },
    async close() {
      closed.abort(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
