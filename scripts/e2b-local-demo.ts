import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import { localUrl } from "./e2b-local-config.js";

const HELP = `本地 E2B 接入演示（只连接回环地址，不回退到云端）

运行：
  pnpm exec tsx scripts/e2b-local-demo.ts

环境变量：
  E2B_API_KEY              必填：本地 E2B 数据库初始化生成的 API key
  LOCAL_E2B_API_URL        默认 http://127.0.0.1:13000
  LOCAL_E2B_SANDBOX_URL    默认 http://127.0.0.1:13002（client-proxy）
  LOCAL_E2B_TEMPLATE       默认 base（需要预先构建）

流程：检查 API → 创建一个 2 分钟沙箱 → 写入/读取文件 → 执行 shell → 删除本次沙箱。
只清理本次演示创建的沙箱，不连接或删除已有 Agent 工作区。
`;


async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(HELP);
    return;
  }
  if (args.length) throw new Error("不支持这些参数；使用 --help 查看说明");

  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("请设置 E2B_API_KEY 为本地 E2B API key；使用 --help 查看说明");
  const apiUrl = localUrl(process.env.LOCAL_E2B_API_URL ?? "http://127.0.0.1:13000", "LOCAL_E2B_API_URL");
  const sandboxUrl = localUrl(process.env.LOCAL_E2B_SANDBOX_URL ?? "http://127.0.0.1:13002", "LOCAL_E2B_SANDBOX_URL");
  const template = process.env.LOCAL_E2B_TEMPLATE?.trim() || "base";
  console.log(`检查本地 API：${apiUrl}/health`);
  let health: Response;
  try {
    health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  } catch {
    throw new Error(`无法连接本地 API ${apiUrl}；需要启动 API、Orchestrator、client-proxy 并构建模板，数据库服务启动还不够`);
  }
  await health.body?.cancel();
  if (!health.ok) throw new Error(`本地 API 健康检查失败：HTTP ${health.status}`);

  let sandbox: Sandbox | undefined;
  try {
    console.log(`创建演示沙箱，模板：${template}`);
    sandbox = await Sandbox.create(template, {
      apiKey,
      apiUrl,
      sandboxUrl,
      domain: "localhost",
      debug: false,
      timeoutMs: 120_000,
      requestTimeoutMs: 60_000,
      metadata: { purpose: "swarm-hive-local-demo", demo_id: randomUUID() },
    });
    console.log(`沙箱已创建：${sandbox.sandboxId}`);
    const marker = `e2b-local-demo-${randomUUID()}`;
    const path = `/tmp/${marker}.txt`;
    await sandbox.files.write(path, `${marker}\n`);
    const contents = await sandbox.files.read(path);
    if (contents !== `${marker}\n`) throw new Error("沙箱文件读写结果不一致");
    const result = await sandbox.commands.run(`cat '${path}'`, { timeoutMs: 15_000 });
    if (result.exitCode !== 0 || result.stdout.trim() !== marker) {
      throw new Error(`沙箱命令验证失败，exitCode=${result.exitCode}`);
    }
    const identity = await sandbox.commands.run("id -un", { timeoutMs: 15_000 });
    if (identity.exitCode !== 0 || identity.stdout.trim() !== "user") {
      throw new Error("默认执行用户不是预期的普通用户 user");
    }
    console.log(`运行用户：${identity.stdout.trim()}`);
    console.log("验证通过：本地 API 创建沙箱、代理连接、文件读写及 shell 执行均正常。");
  } finally {
    if (sandbox) {
      console.log(`清理本次演示沙箱：${sandbox.sandboxId}`);
      const killed = await sandbox.kill({ requestTimeoutMs: 15_000 });
      console.log(killed ? "演示沙箱已删除。" : "演示沙箱已不存在。");
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const key = process.env.E2B_API_KEY?.trim();
  console.error(key ? message.split(key).join("[REDACTED]") : message);
  process.exitCode = 1;
});
