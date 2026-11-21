import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const envNames = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']);
const timestamp = () => new Date().toISOString();
const inputText = value => [{ type: 'text', text: value }];
const failure = (status, message) => Object.assign(new Error(message), { status });

/** The process lives in the Box and owns the adapter independently of HTTP clients. */
export async function startClaudeAcpHost({ directory, workspace, agentHome, sharedDirectory, command = 'claude-agent-acp', host = '127.0.0.1', port = 4501 } = {}) {
  if (!directory || !isAbsolute(directory)) throw new Error('An absolute ACP state directory is required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sessions = new Map();
  const versions = new Map();
  const epoch = randomUUID();
  let revision = 0;
  const tasks = new Set();
  const workers = new Map();
  // Credentials stay in memory and are rebound to the answer when it is dispatched.
  const answerConfigs = new WeakMap();
  const allWorkers = new Set();
  const locks = new Map();
  const dirty = new Set();
  const flushTimers = new Map();
  const idleWorkerMs = 5 * 60 * 1000;
  let server;
  let shuttingDown = false;

  const pathFor = id => join(directory, `${id}.json`);
  async function save(state) {
    const temporary = join(directory, `.${state.id}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, pathFor(state.id));
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      versions.set(state.id, '"' + epoch + '-' + ++revision + '"');
      dirty.delete(state.id);
      const timer = flushTimers.get(state.id);
      if (timer) clearTimeout(timer);
      flushTimers.delete(state.id);
    } finally {
      // A renamed file has no temporary entry. Failed writes leave only a private file.
      await unlink(temporary).catch(() => {});
    }
  }
  function locked(id, action) {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(id, next);
    void next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
    return next;
  }
  function scheduleFlush(state, worker) {
    dirty.add(state.id);
    if (shuttingDown || flushTimers.has(state.id)) return;
    const timer = setTimeout(() => {
      flushTimers.delete(state.id);
      void locked(state.id, async () => {
        if (dirty.has(state.id)) await save(state);
      }).catch(() => { terminateWorker(worker); });
    }, 150);
    timer.unref();
    flushTimers.set(state.id, timer);
  }
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json') || !sessionIdPattern.test(name.slice(0, -5))) continue;
    const state = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (state.id !== name.slice(0, -5) || !Array.isArray(state.turns)) throw new Error(`Invalid ACP state ${name}`);
    let changed = false;
    for (const turn of state.turns) {
      if (turn.status === 'running') {
        turn.status = 'failed'; turn.error = 'Agent 进程已退出，执行结果未知，请检查工作区后重试';
        turn.completedAt = timestamp(); changed = true;
      }
      for (const request of turn.userInputRequests ?? []) {
        if (request.deliveryStatus === 'sending') { request.deliveryStatus = 'unknown'; changed = true; }
        if (request.blocking && request.status === 'pending') {
          request.status = 'answered'; request.answer = '任务中断，问题已失效'; changed = true;
        }
      }
    }
    for (const submission of state.steers ?? []) {
      if (submission.status === 'sending') { submission.status = 'unknown'; changed = true; }
    }
    if (changed) await save(state);
    sessions.set(state.id, state);
    if (!versions.has(state.id)) versions.set(state.id, '"' + epoch + '-' + ++revision + '"');
  }
  function publicState(state) {
    return structuredClone({ threadId: state.threadId ?? null, turns: state.turns });
  }
  function validateQuestions(value) {
    if (!Array.isArray(value) || !value.length || value.length > 3) throw failure(400, '问题数量无效');
    return value.map(question => {
      if (!question || typeof question.title !== 'string' || !question.title.trim() || question.title.length > 20000 ||
          (question.options !== undefined && (!Array.isArray(question.options) || question.options.length > 10 ||
            question.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 20000)))) throw failure(400, '问题格式无效');
      return { title: question.title, ...(question.options ? { options: question.options } : {}) };
    });
  }
  function findRequest(state, requestId) {
    for (const turn of state.turns) {
      const request = turn.userInputRequests?.find(item => item.id === requestId);
      if (request) return { request, turn };
    }
    throw failure(404, '问题不存在');
  }
  function workerEnv(extra) {
    if (extra !== undefined && (!extra || typeof extra !== 'object' || Array.isArray(extra))) throw failure(400, '模型配置无效');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODEX_') && !key.startsWith('CELLBOX_') && !key.startsWith('COCELL_') && !key.startsWith('OPENAI_') && !key.startsWith('ANTHROPIC_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN' && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH' && key !== 'LD_PRELOAD' && key !== 'LD_LIBRARY_PATH'));
    if (agentHome) env.HOME = agentHome;
    if (sharedDirectory) env.PATH = [join(sharedDirectory, 'tools/current/bin'), env.PATH].filter(Boolean).join(':');
    env.CLAUDE_CONFIG_DIR = join(dirname(directory), 'claude');
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (!envNames.has(key) || typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw failure(400, '模型配置无效');
      env[key] = value;
    }
    return env;
  }
  function createWorker(state, env) {
    const child = spawn(command, [], { cwd: state.cwd, env: workerEnv(env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const signature = createHash('sha256').update(JSON.stringify(env ?? {})).digest('hex');
    const worker = { child, signature, secrets: [env?.ANTHROPIC_API_KEY, env?.ANTHROPIC_AUTH_TOKEN].filter(secret => typeof secret === 'string' && secret.trim()), id: 0, pending: new Map(), questions: new Map(), token: randomUUID(), sessionId: null, active: false, exited: false };
    worker.done = new Promise(resolve => { worker.resolveExit = resolve; });
    worker.onError = error => worker.secrets.reduce((message, secret) => message.replaceAll(secret, '[redacted]'), String(error.message || error)).slice(0, 1024);
    worker.send = message => {
      if (worker.exited || !child.stdin.writable) throw new Error('Claude ACP 连接已关闭');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    worker.rpc = (method, params, timeout = 30000) => new Promise((resolvePromise, reject) => {
      const id = ++worker.id;
      const timer = setTimeout(() => { worker.pending.delete(id); reject(new Error(`${method} 结果未知`)); }, timeout);
      worker.pending.set(id, { resolve: resolvePromise, reject, timer });
      try { worker.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); worker.pending.delete(id); reject(error); }
    });
    function onExit(error) {
      if (worker.exited) return;
      worker.exited = true;
      clearTimeout(worker.idleTimer);
      for (const entry of worker.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      worker.pending.clear(); worker.questions.clear();
      if (workers.get(state.id) === worker) workers.delete(state.id);
      allWorkers.delete(worker);
      worker.resolveExit();
    }
    child.on('error', onExit);
    child.stdin.on('error', () => { terminateWorker(worker); });
    child.on('close', (code, signal) => onExit(new Error(`Claude ACP 已退出 (${signal ?? code})`)));
    // Model credentials and upstream responses must never enter server logs.
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      if (worker.retiring) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        void handleRequest(state, worker, message).catch(() => {
          try { worker.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Unable to handle request' } }); } catch {}
        });
      } else if (message.id !== undefined) {
        const entry = worker.pending.get(message.id);
        if (!entry) return;
        worker.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(String(message.error.message ?? 'Claude ACP 请求失败')));
        else entry.resolve(message.result);
      } else if (message.method === 'session/update' && message.params?.sessionId === worker.sessionId) {
        const update = message.params.update;
        if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
          void locked(state.id, () => {
            if (!worker.retiring && applyUpdate(state, update)) scheduleFlush(state, worker);
          }).catch(() => { terminateWorker(worker); });
        }
      } else if (message.method === '$/cancel_request') {
        const entry = [...worker.questions.entries()].find(([, value]) => value.rpcId === message.params?.id);
        if (entry) {
          worker.questions.delete(entry[0]);
          void locked(state.id, async () => {
            const { request } = findRequest(state, entry[0]);
            if (request.status === 'pending') { request.status = 'answered'; request.answer = '问题已失效'; await save(state); }
          }).catch(() => {});
        }
      }
    });
    workers.set(state.id, worker);
    allWorkers.add(worker);
    return worker;
  }
  function applyUpdate(state, update) {
    const turn = [...state.turns].reverse().find(value => value.status === 'running');
    if (!turn || !update) return false;
    const kind = update.sessionUpdate;
    if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && update.content?.type === 'text') {
      const text = update.content.text;
      if (typeof text !== 'string' || !text) return false;
      // Claude can reuse one native message ID for thought and visible text.
      const id = `${kind}:${update.messageId ?? turn.id}`;
      let item = turn.items.find(value => value.id === id);
      if (!item) { item = { id, type: kind === 'agent_message_chunk' ? 'agent_message' : 'reasoning', text: '' }; turn.items.push(item); }
      item.text += text;
      return true;
    }
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return false;
    const id = String(update.toolCallId ?? '');
    if (!id) return false;
    const tool = update._meta?.claudeCode?.toolName ?? update.name;
    let item = turn.items.find(value => value.id === id);
    let changed = false;
    if (!item) {
      if (tool === 'Bash' || update.kind === 'execute') item = { id, type: 'command_execution', command: '', aggregated_output: '', status: 'in_progress' };
      else item = { id, type: 'mcp_tool_call', server: 'claude', tool: String(tool ?? update.title ?? 'tool'), arguments: {}, status: 'in_progress' };
      turn.items.push(item);
      changed = true;
    }
    if (item.type === 'command_execution') {
      if (typeof update.rawInput?.command === 'string' && item.command !== update.rawInput.command) {
        item.command = update.rawInput.command; changed = true;
      }
      if (typeof update.rawOutput === 'string' && item.aggregated_output !== update.rawOutput) {
        item.aggregated_output = update.rawOutput; changed = true;
      }
    } else if (item.type === 'mcp_tool_call') {
      if (update.rawInput !== undefined && JSON.stringify(item.arguments) !== JSON.stringify(update.rawInput)) {
        item.arguments = update.rawInput; changed = true;
      }
      if (update.rawOutput !== undefined) {
        const text = typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput);
        if (item.result?.content?.[0]?.text !== text) { item.result = { content: [{ type: 'text', text }] }; changed = true; }
      }
    }
    if (['completed', 'failed'].includes(update.status) && item.status !== update.status) {
      item.status = update.status; changed = true;
    }
    return changed;
  }
  async function handleRequest(state, worker, message) {
    if (message.method === 'elicitation/create') {
      const properties = message.params?.requestedSchema?.properties ?? {};
      const entries = Object.entries(properties).filter(([name]) => !name.endsWith('_custom'));
      const questions = validateQuestions(entries.map(([name, spec]) => ({ title: spec.title || name,
        ...(Array.isArray(spec.oneOf) ? { options: spec.oneOf.map(option => String(option.const ?? option.title)) } : {}) })));
      await locked(state.id, async () => {
        const turn = [...state.turns].reverse().find(value => value.status === 'running');
        if (!turn) throw new Error('No active turn');
        const request = { id: randomUUID(), questions, status: 'pending', createdAt: timestamp(), blocking: true };
        (turn.userInputRequests ??= []).push(request);
        worker.questions.set(request.id, { rpcId: message.id, keys: entries.map(([name]) => name) });
        try { await save(state); } catch (error) { turn.userInputRequests.pop(); worker.questions.delete(request.id); throw error; }
      });
      return;
    }
    if (message.method === 'session/request_permission') {
      const toolCall = message.params?.toolCall ?? {};
      const options = (message.params?.options ?? []).filter(option => ['allow_once', 'reject_once'].includes(option.kind));
      if (toolCall.name === 'mcp__cocell-user-input__request_user_input_async') {
        const allowed = options.find(option => option.kind === 'allow_once');
        worker.send({ jsonrpc: '2.0', id: message.id, result: { outcome: allowed ? { outcome: 'selected', optionId: allowed.optionId } : { outcome: 'cancelled' } } });
        return;
      }
      await locked(state.id, async () => {
        const turn = [...state.turns].reverse().find(value => value.status === 'running');
        if (!turn || !options.length) throw new Error('No active turn');
        const request = { id: randomUUID(), questions: [{ title: String(toolCall.title ?? toolCall.name ?? '允许此操作？').slice(0, 20000), options: options.map(option => String(option.name).slice(0, 20000)) }], status: 'pending', createdAt: timestamp(), blocking: true };
        (turn.userInputRequests ??= []).push(request);
        worker.questions.set(request.id, { rpcId: message.id, options: options.map(option => ({ name: option.name, optionId: option.optionId })) });
        try { await save(state); } catch (error) { turn.userInputRequests.pop(); worker.questions.delete(request.id); throw error; }
      });
      return;
    }
    worker.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } });
  }
  function terminateWorker(worker, signal = 'SIGTERM') {
    if (worker.exited) return;
    try { process.kill(-worker.child.pid, signal); } catch { worker.child.kill(signal); }
  }
  async function ensureWorker(state, env, model) {
    if (shuttingDown) throw new Error('Claude 运行时正在关闭');
    let worker = workers.get(state.id);
    if (worker) clearTimeout(worker.idleTimer);
    const signature = env === undefined ? undefined : createHash('sha256').update(JSON.stringify(env)).digest('hex');
    if (worker && !worker.exited && signature && worker.signature !== signature) {
      // Drain the previous adapter before loading the same transcript with new credentials.
      worker.retiring = true;
      terminateWorker(worker);
      let timer;
      await Promise.race([worker.done, new Promise(resolvePromise => { timer = setTimeout(resolvePromise, 3000); })]);
      clearTimeout(timer);
      if (!worker.exited) { terminateWorker(worker, 'SIGKILL'); await worker.done; }
      if (workers.get(state.id) === worker) workers.delete(state.id);
      worker = undefined;
    }
    if (worker && !worker.exited) {
      await worker.ready;
      if (model) await worker.rpc('session/set_config_option', { sessionId: worker.sessionId, configId: 'model', value: model });
      return worker;
    }
    worker = createWorker(state, env);
    worker.ready = (async () => {
    try {
      await worker.rpc('initialize', { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } }, clientInfo: { name: 'cocell', version: '1' } });
      const mcpServers = [{ name: 'cocell-user-input', command: process.execPath, args: [join(here, 'questions.mjs')], env: [
        { name: 'COCELL_QUESTION_URL', value: `http://127.0.0.1:${server.address().port}/internal/questions/${state.id}` },
        { name: 'COCELL_QUESTION_TOKEN', value: worker.token },
      ] }];
      if (state.threadId) {
        await worker.rpc('session/load', { sessionId: state.threadId, cwd: state.cwd, mcpServers });
        worker.sessionId = state.threadId;
      } else {
        const created = await worker.rpc('session/new', { cwd: state.cwd, mcpServers });
        if (!created?.sessionId) throw new Error('Claude ACP 未返回会话 ID');
        worker.sessionId = created.sessionId;
        await locked(state.id, async () => {
          state.threadId = created.sessionId;
          try { await save(state); } catch (error) { state.threadId = null; throw error; }
        });
      }
      await worker.rpc('session/set_mode', { sessionId: worker.sessionId, modeId: 'default' });
      if (model) await worker.rpc('session/set_config_option', { sessionId: worker.sessionId, configId: 'model', value: model });
      worker.initialized = true;
      return worker;
    } catch (error) { terminateWorker(worker); if (workers.get(state.id) === worker) workers.delete(state.id); throw error; }
    })();
    return worker.ready;
  }
  async function startPrompt(state, turn, env, model) {
    let worker;
    let promptDispatched = false;
    try {
      worker = await ensureWorker(state, env, model);
      worker.active = true;
      if (turn.cancelRequested) {
        await locked(state.id, async () => { turn.status = 'cancelled'; turn.completedAt = timestamp(); await save(state); });
        return;
      }
      const prompt = inputText(turn.prompt);
      for (const path of turn.images) {
        const full = resolve(state.cwd, path);
        const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        let data; try { data = await file.readFile(); } finally { await file.close(); }
        if (data.length > 10 * 1024 * 1024) throw new Error('图片过大');
        const mimeType = /\.png$/i.test(full) ? 'image/png' : /\.webp$/i.test(full) ? 'image/webp' : 'image/jpeg';
        prompt.push({ type: 'image', mimeType, data: data.toString('base64') });
      }
      if (turn.cancelRequested) {
        await locked(state.id, async () => { turn.status = 'cancelled'; turn.completedAt = timestamp(); await save(state); });
        return;
      }
      promptDispatched = true;
      const result = await worker.rpc('session/prompt', { sessionId: worker.sessionId, prompt }, 24 * 60 * 60 * 1000);
      await locked(state.id, async () => {
        if (result?.stopReason === 'cancelled' && !turn.cancelRequested) {
          turn.status = 'failed'; turn.error = 'Agent 执行中断，执行结果未知，请检查工作区后重试';
        } else turn.status = result?.stopReason === 'cancelled' ? 'cancelled' : 'completed';
        turn.completedAt = timestamp();
        if (turn.answerRequestId) {
          const { request } = findRequest(state, turn.answerRequestId);
          if (turn.status === 'completed') {
            request.status = 'answered'; request.deliveryStatus = 'accepted'; request.answeredAt = timestamp();
            request.answer = request.answers.join('\n\n');
          } else request.deliveryStatus = 'unknown';
        }
        await save(state);
      });
    } catch (error) {
      await locked(state.id, async () => {
        turn.status = 'failed'; turn.error = worker ? worker.onError(error) : 'Claude Agent 启动失败';
        if (promptDispatched) turn.error += '，执行结果未知，请检查工作区后重试';
        turn.completedAt = timestamp();
        if (turn.answerRequestId) findRequest(state, turn.answerRequestId).request.deliveryStatus = 'unknown';
        await save(state);
      });
    } finally {
      if (worker) {
        worker.active = false;
        clearTimeout(worker.idleTimer);
        worker.idleTimer = setTimeout(() => {
          void locked(state.id, async () => {
            if (workers.get(state.id) === worker && !worker.active && !state.turns.some(value => value.status === 'running')) {
              workers.delete(state.id);
              terminateWorker(worker);
            }
          }).catch(() => {});
        }, idleWorkerMs);
        worker.idleTimer.unref();
      }
      if (!shuttingDown) void dispatchAnswer(state).catch(() => {});
    }
  }
  function launchPrompt(state, turn, env, model) {
    const task = startPrompt(state, turn, env, model);
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
  }
  async function dispatchAnswer(state) {
    if (shuttingDown) return;
    await locked(state.id, async () => {
      if (state.turns.some(turn => turn.status === 'running') || state.steers?.some(item => item.status === 'sending')) return;
      const source = state.turns.flatMap(turn => turn.userInputRequests ?? []).find(item => item.status === 'queued' && item.deliveryStatus === 'queued');
      const worker = workers.get(state.id);
      const config = source && answerConfigs.get(source);
      if (!source || (!config && (!worker || worker.exited || !worker.sessionId || !worker.initialized))) return;
      source.deliveryStatus = 'sending';
      const prompt = 'The user answered earlier question ' + source.id + '.\n' + source.questions.map((question, index) => `${question.title}\nAnswer: ${source.answers[index]}`).join('\n\n');
      const turn = { id: source.answerTurnId, prompt, images: [], status: 'running', items: [], startedAt: timestamp(), answerRequestId: source.id };
      state.turns.push(turn);
      try { await save(state); } catch (error) { state.turns.pop(); source.deliveryStatus = 'queued'; throw error; }
      answerConfigs.delete(source);
      launchPrompt(state, turn, config?.env, config?.model);
    });
  }
  function ensureId(value) { if (!sessionIdPattern.test(value ?? '')) throw failure(400, '会话 ID 无效'); }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return { protocol: 'cocell-claude-acp-v1', active: [...sessions.values()].some(state => state.steers?.some(item => item.status === 'sending') || state.turns.some(turn => turn.status === 'running' || turn.userInputRequests?.some(request => request.status === 'queued' && ['queued', 'sending'].includes(request.deliveryStatus)))) };
    const match = /^\/(internal\/questions|sessions)\/([^/]+)(?:\/(turns|stop|answers|verify|reconcile))?$/.exec(url.pathname);
    if (!match) throw failure(404, '未找到');
    const [, group, id, action] = match;
    ensureId(id);
    if (req.method === 'GET' && group === 'sessions' && action === 'verify') {
      const state = sessions.get(id);
      if (!state) throw failure(404, '会话不存在');
      let persisted;
      try { persisted = JSON.parse(await readFile(pathFor(id), 'utf8')); }
      catch { throw failure(409, '会话状态文件不可读'); }
      if (persisted.id !== id || persisted.threadId !== state.threadId || persisted.cwd !== state.cwd) throw failure(409, '会话状态文件不匹配');
      if (state.threadId) {
        if (!sessionIdPattern.test(state.threadId) || !isAbsolute(state.cwd ?? '')) throw failure(409, '原生会话标识无效');
        const project = state.cwd.replace(/[^a-zA-Z0-9]/g, '-');
        const transcript = join(dirname(directory), 'claude', 'projects', project, state.threadId + '.jsonl');
        let file;
        try {
          file = await open(transcript, constants.O_RDONLY | constants.O_NOFOLLOW);
          const buffer = Buffer.alloc(2 * 1024 * 1024);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
          let matching = false;
          for (const line of lines.slice(0, -1)) {
            try {
              const record = JSON.parse(line);
              if (record.sessionId && record.sessionId !== state.threadId) throw failure(409, '原生会话标识不匹配');
              if (record.sessionId === state.threadId && record.cwd === state.cwd) { matching = true; break; }
            } catch (error) { if (error.status) throw error; }
          }
          if (!matching) throw failure(409, '原生会话历史不可验证');
        } catch (error) {
          if (error.status) throw error;
          throw failure(409, '原生会话历史不可读取');
        } finally { await file?.close(); }
      }
      return { verified: true };
    }
    if (req.method === 'GET' && group === 'sessions' && !action) {
      const state = sessions.get(id);
      if (!state) throw failure(404, '会话不存在');
      const etag = versions.get(id);
      res.setHeader('etag', etag);
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
      return publicState(state);
    }
    if (req.method === 'PUT' && group === 'sessions' && !action) {
      return locked(id, async () => {
        let state = sessions.get(id);
        if (!state) { state = { id, cwd: null, threadId: null, turns: [] }; await save(state); sessions.set(id, state); }
        return publicState(state);
      });
    }
    if (req.method !== 'POST') throw failure(404, '未找到');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw failure(413, '请求过大'); chunks.push(chunk); }
    let body;
    try { body = size === 0 && group === 'sessions' && action === 'stop' ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw failure(400, '请求格式无效'); }
    if (group === 'internal/questions') {
      const worker = workers.get(id);
      const token = String(req.headers.authorization ?? '');
      const expected = `Bearer ${worker?.token ?? ''}`;
      if (!worker || Buffer.byteLength(token) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) throw failure(403, '无权限');
      const questions = validateQuestions(body.questions);
      return locked(id, async () => {
        const state = sessions.get(id), turn = [...state.turns].reverse().find(value => value.status === 'running');
        if (!turn) throw failure(409, '当前没有运行中的任务');
        const request = { id: randomUUID(), questions, status: 'pending', createdAt: timestamp() };
        (turn.userInputRequests ??= []).push(request);
        try { await save(state); } catch (error) { turn.userInputRequests.pop(); throw error; }
        return { id: request.id };
      });
    }
    const operation = await locked(id, async () => {
      let state = sessions.get(id);
      if (action === 'turns') {
        ensureId(body.id);
        if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 200000 || !isAbsolute(body.cwd ?? '') ||
            !Array.isArray(body.images ?? []) || (body.images ?? []).length > 5 || (body.images ?? []).some(path => typeof path !== 'string' || path.length > 4096) ||
            (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 200))) throw failure(400, '任务参数无效');
        workerEnv(body.env);
        if (workspace) {
          const work = relative(resolve(workspace), resolve(body.cwd));
          if (work === '..' || work.startsWith('../') || isAbsolute(work)) throw failure(400, '工作目录不在项目中');
        }
        if (!state) { state = { id, cwd: resolve(body.cwd), threadId: null, turns: [] }; sessions.set(id, state); }
        if (state.cwd && state.cwd !== resolve(body.cwd)) throw failure(409, '会话工作目录不匹配');
        const imageRoot = join(resolve(workspace ?? body.cwd), '.cocell', 'images');
        for (const image of body.images ?? []) {
          if (!isAbsolute(image) || dirname(image) !== imageRoot || !new RegExp('^' + id + '-[0-9a-f-]{36}\\.(png|jpg|webp)$', 'i').test(image.slice(imageRoot.length + 1))) throw failure(400, '图片路径无效');
        }
        if (!state.cwd) state.cwd = resolve(body.cwd);
        const existing = state.turns.find(turn => turn.id === body.id);
        if (existing) {
          if (existing.prompt !== body.prompt || JSON.stringify(existing.images) !== JSON.stringify(body.images ?? [])) throw failure(409, '任务 ID 已用于不同输入');
          return { turnId: existing.id };
        }
        const prior = (state.steers ?? []).find(item => item.id === body.id);
        if (prior) {
          if (prior.prompt !== body.prompt) throw failure(409, '任务 ID 已用于不同输入');
          if (prior.status === 'failed') throw failure(422, '任务已结束，追加消息没有发送，请重新提交');
          if (prior.status !== 'accepted') throw failure(409, '追加消息的结果未知，请查看会话历史');
          return { turnId: prior.turnId };
        }
        const running = state.turns.find(turn => turn.status === 'running');
        if (running) {
          if (body.images?.length) throw failure(409, '任务执行中只能追加文字消息');
          const worker = workers.get(id);
          if (!worker?.active || !worker.sessionId) throw failure(409, '任务尚未就绪，请稍后重试');
          const submission = { id: body.id, prompt: body.prompt, turnId: running.id, status: 'sending' };
          (state.steers ??= []).push(submission);
          try { await save(state); } catch (error) { state.steers.pop(); throw error; }
          return { steer: { state, worker, submission, turn: running } };
        }
        const turn = { id: body.id, prompt: body.prompt, images: body.images ?? [], status: 'running', items: [], startedAt: timestamp() };
        state.turns.push(turn);
        try { await save(state); } catch (error) { state.turns.pop(); throw error; }
        launchPrompt(state, turn, body.env, body.model);
        return { turnId: turn.id };
      }
      if (!state) throw failure(404, '会话不存在');
      if (action === 'reconcile') {
        if (!isAbsolute(body.cwd ?? '') || resolve(body.cwd) !== state.cwd) throw failure(409, '会话工作目录不匹配');
        workerEnv(body.env);
        const pending = state.turns.flatMap(turn => turn.userInputRequests ?? [])
          .filter(request => request.status === 'queued' && request.deliveryStatus === 'queued');
        for (const request of pending) if (!answerConfigs.has(request)) answerConfigs.set(request, { env: body.env, model: body.model });
        if (!pending.length || state.turns.some(turn => turn.status === 'running') || state.steers?.some(item => item.status === 'sending')) return { ok: true };
        return { reconcile: { state } };
      }
      if (action === 'stop') {
        const worker = workers.get(id);
        const turn = [...state.turns].reverse().find(value => value.status === 'running');
        if (turn) {
          const previous = turn.cancelRequested;
          turn.cancelRequested = true;
          try { await save(state); } catch (error) {
            if (previous === undefined) delete turn.cancelRequested; else turn.cancelRequested = previous;
            throw error;
          }
        }
        if (worker?.active && worker.sessionId) worker.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: worker.sessionId } });
        return { ok: true };
      }
      if (action === 'answers') {
        const { request, turn: ownerTurn } = findRequest(state, body.requestId);
        if (body.ownerTurnId && body.ownerTurnId !== ownerTurn.id) throw failure(409, '问题不属于此任务');
        if (!Array.isArray(body.answers) || body.answers.length !== request.questions.length || body.answers.some(answer => typeof answer !== 'string' || !answer.trim() || answer.length > 20000)) throw failure(400, '请回答所有问题');
        if (!request.blocking && body.env !== undefined) {
          if (!isAbsolute(body.cwd ?? '') || resolve(body.cwd) !== state.cwd) throw failure(409, '会话工作目录不匹配');
          workerEnv(body.env);
          if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 200)) throw failure(400, '模型无效');
        }
        if (request.status !== 'pending') {
          if (JSON.stringify(request.answers) === JSON.stringify(body.answers) && request.deliveryStatus !== 'unknown') {
            if (request.deliveryStatus === 'queued') {
              if (body.env !== undefined && !answerConfigs.has(request)) answerConfigs.set(request, { env: body.env, model: body.model });
              setImmediate(() => { void dispatchAnswer(state).catch(() => {}); });
            }
            return { ok: true, request };
          }
          throw failure(409, '问题已经回答或结果未知');
        }
        const pending = workers.get(id)?.questions.get(request.id);
        if (request.blocking) {
          if (!pending) throw failure(409, '问题连接已结束');
          const worker = workers.get(id);
          const selected = pending.options?.find(option => option.name === body.answers[0]);
          if (pending.options && !selected) throw failure(400, '请选择有效的授权选项');
          const result = pending.options ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { action: 'accept', content: Object.fromEntries(pending.keys.map((key, index) => [key, body.answers[index]])) };
          const previous = structuredClone(request);
          request.status = 'queued'; request.deliveryStatus = 'sending'; request.answers = body.answers;
          try { await save(state); } catch (error) { Object.assign(request, previous); delete request.deliveryStatus; delete request.answers; throw error; }
          try { worker.send({ jsonrpc: '2.0', id: pending.rpcId, result }); }
          catch (error) { request.deliveryStatus = 'unknown'; await save(state); throw error; }
          worker.questions.delete(request.id);
          request.status = 'answered'; request.deliveryStatus = 'accepted';
          request.answer = body.answers.join('\n\n'); request.answeredAt = timestamp();
          await save(state);
        } else {
          request.status = 'queued'; request.deliveryStatus = 'queued'; request.answers = body.answers; request.answerTurnId = randomUUID();
          try { await save(state); } catch (error) {
            request.status = 'pending'; delete request.deliveryStatus; delete request.answers; delete request.answerTurnId; throw error;
          }
        }
        if (!request.blocking) {
          if (body.env !== undefined) answerConfigs.set(request, { env: body.env, model: body.model });
          setImmediate(() => { void dispatchAnswer(state).catch(() => {}); });
        }
        return { ok: true, request };
      }
      throw failure(404, '未找到');
    });
    if (operation.reconcile) {
      await dispatchAnswer(operation.reconcile.state);
      return { ok: true };
    }
    if (!operation.steer) return operation;
    const { state, worker, submission, turn } = operation.steer;
    try {
      const result = await worker.rpc('_session/steering', { sessionId: worker.sessionId, prompt: inputText(submission.prompt),
        _meta: { steering: { idleBehavior: 'promptRequired' } } }, 15000);
      if (result?.outcome !== 'injected') {
        await locked(id, async () => { submission.status = 'failed'; await save(state); });
        throw failure(422, '任务已结束，追加消息没有发送，请重新提交');
      }
      await locked(id, async () => {
        submission.status = 'accepted';
        (turn.additionalUserInputs ??= []).push(submission.prompt);
        await save(state);
      });
      void dispatchAnswer(state).catch(() => {});
      return { turnId: turn.id };
    } catch (error) {
      if (error.status) { void dispatchAnswer(state).catch(() => {}); throw error; }
      await locked(id, async () => { submission.status = 'unknown'; await save(state); });
      void dispatchAnswer(state).catch(() => {});
      throw failure(409, '追加消息的结果未知，请查看会话历史');
    }
  }
  server = createServer((req, res) => {
    void handle(req, res).then(value => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
    }).catch(error => {
      res.writeHead(error.status ?? 500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error.status ? error.message : 'Claude 运行时请求失败' }));
    });
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(port, host, resolvePromise); });
  let closePromise;
  return { port: server.address().port, close() {
    if (!closePromise) closePromise = (async () => {
      shuttingDown = true;
      const children = [...allWorkers];
      for (const worker of children) terminateWorker(worker);
      server.closeAllConnections(); await new Promise(resolvePromise => server.close(resolvePromise));
      let timer;
      await Promise.race([Promise.allSettled(children.map(worker => worker.done)), new Promise(resolvePromise => { timer = setTimeout(resolvePromise, 3000); })]);
      clearTimeout(timer);
      for (const worker of children) if (!worker.exited) terminateWorker(worker, 'SIGKILL');
      await Promise.allSettled(children.map(worker => worker.done));
      await Promise.allSettled([...tasks]);
      await Promise.allSettled([...locks.values()]);
      for (const timer of flushTimers.values()) clearTimeout(timer);
      flushTimers.clear();
      for (const id of dirty) {
        const state = sessions.get(id);
        if (state) await locked(id, () => save(state));
      }
    })();
    return closePromise;
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.COCELL_ACP_STATE_DIR || '/home/agent/workspace/.cocell/claude-acp';
  const runtime = await startClaudeAcpHost({ directory, command: process.env.COCELL_CLAUDE_ACP_COMMAND || 'claude-agent-acp' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void runtime.close().then(() => process.exit(0)); });
}
