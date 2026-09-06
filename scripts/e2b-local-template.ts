import { Template } from "e2b";
import { localUrl } from "./e2b-local-config.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(`构建本地 E2B 基础模板（1 vCPU、512 MB 内存）。
运行：pnpm exec tsx scripts/e2b-local-template.ts
必填 E2B_API_KEY；LOCAL_E2B_API_URL 默认 http://127.0.0.1:13000。
LOCAL_E2B_TEMPLATE 默认 base。仅连接回环 API，不回退到云端。
构建会下载基础镜像，并创建或更新指定模板别名。`);
    return;
  }
  if (args.length) throw new Error("不支持这些参数；使用 --help 查看说明");
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("请设置 E2B_API_KEY 为本地 E2B API key");
  const apiUrl = localUrl(process.env.LOCAL_E2B_API_URL ?? "http://127.0.0.1:13000", "LOCAL_E2B_API_URL");
  const sandboxUrl = localUrl(process.env.LOCAL_E2B_SANDBOX_URL ?? "http://127.0.0.1:13002", "LOCAL_E2B_SANDBOX_URL");
  const template = process.env.LOCAL_E2B_TEMPLATE?.trim() || "base";
  let health: Response;
  try {
    health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  } catch {
    throw new Error(`无法连接本地 API ${apiUrl}，请先启动本地 E2B 后端`);
  }
  await health.body?.cancel();
  if (!health.ok) throw new Error(`本地 API 健康检查失败：HTTP ${health.status}`);
  console.log(`开始构建 ${template}：1 vCPU、512 MB 内存；API=${apiUrl}`);
  // A restrictive host service umask can leave the generated guest root at
  // 0700. Restore guest traversal permissions before publishing the template.
  const definition = Template().fromBaseImage().runCmd("chmod 0755 /", { user: "root" });
  const result = await Template.build(definition, template, {
    apiKey,
    apiUrl,
    sandboxUrl,
    domain: "localhost",
    debug: false,
    cpuCount: 1,
    memoryMB: 512,
    requestTimeoutMs: 60_000,
    onBuildLogs: (entry) => console.log(entry.toString().split(apiKey).join("[REDACTED]")),
  });
  console.log(`模板构建完成：${result.templateId}，build=${result.buildId}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const key = process.env.E2B_API_KEY?.trim();
  console.error(key ? message.split(key).join("[REDACTED]") : message);
  process.exitCode = 1;
});
