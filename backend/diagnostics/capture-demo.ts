import { loadEnvFile } from 'node:process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { Codex } from '../../packages/agentcore/src/index.mjs';
import { startHttpCapture } from './http-capture.js';

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

const analyzeIndex = process.argv.indexOf('--analyze');
const analyzePath = analyzeIndex >= 0 ? process.argv[analyzeIndex + 1] : undefined;
if (analyzeIndex >= 0 && !analyzePath) throw new Error('--analyze 需要指定已有抓包目录');
const directory = analyzePath ? resolve(analyzePath) : resolve('tmp/artifacts/http-capture', new Date().toISOString().replaceAll(':', '-'));
if (!analyzePath) {
const upstreamBaseUrl = process.env.OPENAI_BASE_URL;
if (!upstreamBaseUrl) throw new Error('请设置 OPENAI_BASE_URL，指定要记录的 Responses API 上游地址');
await mkdir(directory, { recursive: true, mode: 0o700 });
const capture = await startHttpCapture({ upstreamBaseUrl, directory });
console.log(`HTTP 抓包目录: ${directory}`);

if (process.argv.includes('--serve')) {
  console.log(`本机抓包代理: ${capture.baseUrl}`);
  console.log('将另一个终端中 Demo 的 OPENAI_BASE_URL 设置为此地址，再启动 Demo。按 Ctrl+C 停止。');
  await new Promise<void>(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
  await capture.close();
} else {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'codex-http-capture-'));
  const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  const sdkConfig = process.env.CODEX_CONFIG_JSON ? JSON.parse(process.env.CODEX_CONFIG_JSON) : {};
  const rawOverrides: string[] = process.env.CODEX_CONFIG_OVERRIDES_JSON ? JSON.parse(process.env.CODEX_CONFIG_OVERRIDES_JSON) : [];
  const provider = 'codex_http_capture';
  const codex = new Codex({
    ...(apiKey ? { apiKey } : {}),
    ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
    config: {
      ...sdkConfig,
      model_providers: {
        ...sdkConfig.model_providers,
        [provider]: {
          name: 'Local HTTP capture', base_url: capture.baseUrl,
          wire_api: 'responses', supports_websockets: false,
          ...(apiKey ? { env_key: 'CODEX_API_KEY' } : { requires_openai_auth: true }),
        },
      },
    },
    configOverrides: [...rawOverrides, `model_provider="${provider}"`],
  });
  try {
    const thread = codex.startThread({
      workingDirectory, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never',
      webSearchMode: 'disabled', networkAccessEnabled: false,
      ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
      modelReasoningEffort: 'medium',
    });
    const { events } = await thread.runStreamed(
      '这是一次 HTTP 工具协议验证。请实际调用一次终端工具执行 printf codex-http-capture-ok，不要读取文件或修改任何文件，然后直接回复命令输出。',
      { signal: AbortSignal.timeout(120_000) },
    );
    for await (const event of events) {
      if (event.type === 'thread.started') console.log(`Thread: ${event.thread_id}`);
      else if (event.type === 'item.completed') console.log(`SDK item: ${event.item.type}`);
      else if (event.type === 'turn.failed') throw new Error(event.error.message);
      else if (event.type === 'turn.completed') console.log('真实 SDK 任务完成');
    }
  } catch (error) {
    // Keep captures even on failure. Error strings from upstream may contain user data.
    console.error(`SDK 任务失败 (${error instanceof Error ? error.name : 'unknown'})，请检查抓包文件。`);
    process.exitCode = 1;
  } finally { await capture.close(); }
}
}

function decode(buffer: Buffer, encoding?: string): string {
  for (const value of (encoding || '').split(',').map(x => x.trim()).filter(Boolean).reverse()) {
    if (value === 'gzip') buffer = gunzipSync(buffer);
    else if (value === 'br') buffer = brotliDecompressSync(buffer);
    else if (value === 'deflate') buffer = inflateSync(buffer);
    else if (value === 'zstd') buffer = zstdDecompressSync(buffer);
    else if (value !== 'identity') throw new Error(`不支持的 content-encoding: ${value}`);
  }
  return buffer.toString('utf8');
}

const exchanges: unknown[] = [];
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const location = join(directory, entry.name);
  try {
    const requestMeta = JSON.parse(await readFile(join(location, 'request.json'), 'utf8'));
    const responseMeta = JSON.parse(await readFile(join(location, 'response.json'), 'utf8'));
    const requestText = decode(await readFile(join(location, 'request.body')), requestMeta.headers?.['content-encoding']);
    const responseText = decode(await readFile(join(location, 'response.body')), responseMeta.headers?.['content-encoding']);
    const request = JSON.parse(requestText);
    await writeFile(join(location, 'request.decoded.json'), JSON.stringify(request, null, 2), { mode: 0o600 });
    await writeFile(join(location, 'response.decoded.txt'), responseText, { mode: 0o600 });
    const events = responseText.split(/\r?\n\r?\n/).flatMap(block => {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    });
    const toolTypes = new Set(['custom_tool_call', 'function_call', 'custom_tool_call_output', 'function_call_output']);
    const toolFields = ['type', 'name', 'call_id', 'input', 'arguments', 'output'];
    const toolMessage = (item: Record<string, unknown>) => Object.fromEntries(toolFields.filter(key => key in item).map(key => [key, item[key]]));
    const calls = events.filter(event => event.type === 'response.output_item.done' && toolTypes.has(event.item?.type)).map(event => toolMessage(event.item));
    // Codex can send definitions as input[].additional_tools, including namespaces,
    // instead of the public API's usual top-level tools field.
    const definitions = [
      ...(request.tools || []),
      ...(request.input || []).filter((item: Record<string, unknown>) => item.type === 'additional_tools').flatMap((item: { tools?: unknown[] }) => item.tools || []),
    ];
    function toolOverview(tool: Record<string, unknown>): Record<string, unknown> {
      return { type: tool.type, name: tool.name, format: tool.format,
        ...(Array.isArray(tool.tools) ? { tools: tool.tools.map(toolOverview) } : {}) };
    }
    const summary = {
      directory: entry.name, method: requestMeta.method, url: requestMeta.url, status: responseMeta.status ?? responseMeta.statusCode,
      model: request.model, stream: request.stream,
      responseTransportComplete: responseMeta.complete,
      responseProtocolCompleted: events.some(event => event.type === 'response.completed'),
      tools: definitions.map(toolOverview),
      inputTypes: (request.input || []).map((item: Record<string, unknown>) => item.type || item.role),
      toolMessagesSentToModel: (request.input || []).filter((item: Record<string, unknown>) => toolTypes.has(String(item.type))).map(toolMessage),
      eventTypes: [...new Set(events.map(event => event.type))], toolCallsReturnedByModel: calls,
    };
    exchanges.push(summary);
    await writeFile(join(location, 'tools.json'), JSON.stringify(definitions, null, 2), { mode: 0o600 });
    console.log(`${entry.name}: HTTP ${summary.status}, stream=${summary.stream}, tools=${summary.tools.map((tool: { name?: string; type?: string }) => tool.name || tool.type).join(', ')}, 返回工具调用=${calls.length}`);
  } catch (error) {
    exchanges.push({ directory: entry.name, decodeError: error instanceof Error ? error.message : String(error) });
    console.error(`${entry.name}: 未完成解码，原始字节仍保存在 request.body / response.body`);
  }
}
await writeFile(join(directory, 'summary.json'), JSON.stringify(exchanges, null, 2), { mode: 0o600 });
console.log(`分析摘要: ${join(directory, 'summary.json')}`);
