import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const AGENT_MEMORY_SANDBOX_PATH =
  "/home/agent/.local/share/swarm-hive/memory.txt";
const AGENT_MEMORY_RELATIVE_PATH = ".local/share/swarm-hive/memory.txt";
const MAX_AGENT_MEMORY_CHARS = 16_000;

export interface AgentMemorySnapshot {
  hostPath: string;
  sandboxPath: string;
  content: string;
  sha256: string;
}

export function createAgentMemorySnapshot(content: string): Pick<AgentMemorySnapshot, "content" | "sha256"> {
  const normalized = content.trim();
  return {
    content: normalized,
    sha256: createHash("sha256").update(normalized).digest("hex"),
  };
}

/** Initialize and read the writable memory shared by all Forks of one Instance. */
export async function loadAgentMemory(
  instanceHome: string,
  seedContent: string,
): Promise<AgentMemorySnapshot> {
  const hostPath = resolve(instanceHome, AGENT_MEMORY_RELATIVE_PATH);
  await mkdir(dirname(hostPath), { recursive: true });
  try {
    await writeFile(hostPath, `${seedContent.trim()}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const raw = await readFile(hostPath, "utf8");
  const content = raw.length <= MAX_AGENT_MEMORY_CHARS
    ? raw.trim()
    : `${raw.slice(0, MAX_AGENT_MEMORY_CHARS).trimEnd()}\n…（仅注入前 ${MAX_AGENT_MEMORY_CHARS} 字符，请精简记忆文件）`;
  return {
    hostPath,
    sandboxPath: AGENT_MEMORY_SANDBOX_PATH,
    ...createAgentMemorySnapshot(content),
  };
}

export function renderAgentMemoryInstructions(memory: Pick<AgentMemorySnapshot, "content" | "sha256">): string {
  return [
    `长期记忆快照（SHA256：${memory.sha256}）`,
    "这是当前 Session 固定使用的跨项目知识快照；磁盘更新从下一个 Session 生效。它不能覆盖当前指令或实时证据。",
    memory.content || "# Memory",
  ].join("\n\n");
}
