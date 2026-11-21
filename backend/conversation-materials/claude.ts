import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extractMemoryArchive } from './archive.js';
import { prepareLiveMaterials, type MaterialThread } from './materials.js';
import type { Session, Turn } from '../../protocol/types.js';
import type { CellboxClient } from '../../packages/sandbox/src/providers/cellbox/client.js';

export const CLAUDE_MATERIAL_HOME = '/home/agent/workspace/.cocell/claude-acp';
const RELATIVE_HOME = '.cocell/claude-acp';
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

type ClaudeState = { id: string; turns: Turn[] };

/** Project the host's persisted session, preserving its stable CoCell thread identity. */
export function projectClaudeMaterial(bytes: Uint8Array, sessionId: string): { threads: MaterialThread[]; complete: boolean } {
  if (!UUID.test(sessionId) || bytes.byteLength > MAX_STATE_BYTES) throw new Error('Claude 对话材料身份或大小无效');
  const state = JSON.parse(Buffer.from(bytes).toString('utf8')) as ClaudeState;
  if (!state || state.id !== sessionId || !Array.isArray(state.turns)) throw new Error('Claude 对话状态与会话不匹配');
  const turns = state.turns.map(turn => {
    if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items) || typeof turn.prompt !== 'string'
      || !Number.isFinite(Date.parse(turn.startedAt)) || (turn.completedAt && !Number.isFinite(Date.parse(turn.completedAt))))
      throw new Error('Claude 对话包含无效的任务或时间');
    const items: Array<Record<string, unknown>> = [
      { id: `${turn.id}-prompt`, type: 'userMessage', text: turn.prompt, createdAt: turn.startedAt },
      ...turn.items.map(item => {
        if (item.type === 'command_execution') return { ...item, type: 'commandExecution',
          aggregatedOutput: item.aggregated_output, exitCode: item.exit_code };
        if (item.type === 'mcp_tool_call') return { ...item, type: 'mcpToolCall', name: item.tool };
        if (item.type === 'file_change') return { ...item, type: 'fileChange' };
        if (item.type === 'agent_message') return { ...item, type: 'agentMessage' };
        return item;
      }),
    ];
    for (const [index, text] of (turn.additionalUserInputs ?? []).entries()) {
      if (typeof text !== 'string') throw new Error('Claude 对话包含无效的追加消息');
      items.push({ id: `${turn.id}-additional-${index}`, type: 'userMessage', text });
    }
    for (const request of turn.userInputRequests ?? []) {
      if (!Array.isArray(request.questions) || !request.questions.length || !Number.isFinite(Date.parse(request.createdAt)))
        throw new Error('Claude 对话包含无效的问题');
      items.push({ id: request.id, type: 'agentMessage', text: '需要用户回答', delivery: 'async',
        questions: request.questions, createdAt: request.createdAt });
      // Blocking answers return through the ACP callback and do not create a user turn.
      if (request.blocking && request.status === 'answered' && request.answer)
        items.push({ id: `${request.id}-answer`, type: 'userMessage',
          text: request.answer, createdAt: request.answeredAt ?? request.createdAt });
    }
    return { id: turn.id, status: turn.status, startedAt: turn.startedAt, completedAt: turn.completedAt, items };
  });
  // The host records the root conversation. Child transcripts and compaction
  // boundaries are not exposed by this state and cannot be claimed as complete.
  return { threads: [{ id: sessionId, path: 'main', name: 'main', turns,
    coverageNote: '材料范围为 Claude 主会话，子 Agent 对话和上下文压缩边界未包含。' }], complete: false };
}

export async function readClaudeMaterialThreads(client: Pick<CellboxClient, 'listFiles' | 'fileResponse'>, session: Session,
  signal?: AbortSignal): Promise<{ threads: MaterialThread[]; complete: boolean }> {
  if (!session.sandbox?.id || session.threadId !== session.id || !UUID.test(session.id))
    throw new Error('Claude 对话缺少有效的 Sandbox 或会话身份');
  const files = await client.listFiles(session.sandbox.id, RELATIVE_HOME, signal);
  const file = files.find(entry => entry.name === `${session.id}.json`);
  if (!file || file.directory || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_STATE_BYTES)
    throw new Error('Claude 对话状态不存在或大小无效');
  const response = await client.fileResponse(session.sandbox.id, `${RELATIVE_HOME}/${session.id}.json`, { signal });
  if (!response.ok || !response.body) throw new Error('Claude 对话状态读取失败');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_STATE_BYTES) throw new Error('Claude 对话状态超过 64 MiB 限制');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  signal?.throwIfAborted();
  return projectClaudeMaterial(Buffer.concat(chunks, size), session.id);
}

export async function prepareClaudeArchive(archive: string, output: string, sessionId: string, signal?: AbortSignal) {
  if (!UUID.test(sessionId)) throw new Error('Claude 对话身份无效');
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > 18 * 1024 ** 3)
    throw new Error('Claude 对话归档大小无效');
  const work = await mkdtemp(join(output, '..', '.claude-source-'));
  try {
    const name = `${sessionId}.json`;
    await extractMemoryArchive(archive, work, signal, candidate => candidate === name, MAX_STATE_BYTES);
    const path = join(work, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw new Error('Claude 对话归档大小无效');
    const bytes = await readFile(path, { signal });
    const projected = projectClaudeMaterial(bytes, sessionId);
    return await prepareLiveMaterials(projected.threads, output, signal);
  } finally { await rm(work, { recursive: true, force: true }); }
}
