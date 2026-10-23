import { parentPort, workerData } from 'node:worker_threads';
import { TextDecoder } from 'node:util';
import { parse as parseYaml } from 'yaml';

const MAX_BYTES = 1024 * 1024;
const validBase64 = value => {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BYTES / 3) * 4) return undefined;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length <= MAX_BYTES && bytes.toString('base64') === value ? bytes : undefined;
  } catch { return undefined; }
};

function codecCall(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 8 * 1024 * 1024) return '{"ok":false}';
    const { op, value } = JSON.parse(raw);
    let result;
    if (op === 'utf8.decode') {
      const bytes = validBase64(value);
      if (!bytes) return '{"ok":false}';
      result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } else if (op === 'utf8.encode') {
      if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) return '{"ok":false}';
      result = Buffer.from(value, 'utf8').toString('base64');
    } else if (op === 'yaml.parse') {
      if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) return '{"ok":false}';
      result = parseYaml(value, { maxAliasCount: 50 });
    } else if (op === 'base64.decode') {
      const bytes = validBase64(value);
      if (!bytes) return '{"ok":false}';
      result = [...bytes];
    } else if (op === 'base64.encode') {
      if (!Array.isArray(value) || value.length > MAX_BYTES || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return '{"ok":false}';
      result = Buffer.from(value).toString('base64');
    } else return '{"ok":false}';
    const response = JSON.stringify({ ok: true, result });
    return response.length <= 8 * 1024 * 1024 ? response : '{"ok":false}';
  } catch {
    return '{"ok":false}';
  }
}

try {
  const vm = await import('node:vm');
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  const hostBridge = raw => codecCall(raw);
  Object.setPrototypeOf(hostBridge, null);
  Object.freeze(hostBridge);
  context.__hostBridge = hostBridge;
  const setup = new vm.Script(`(() => {
    const bridge = globalThis.__hostBridge;
    delete globalThis.__hostBridge;
    const call = (op, value) => {
      const raw = bridge(JSON.stringify({op, value}));
      const response = JSON.parse(raw);
      if (!response || response.ok !== true) throw new Error('credential codec failed');
      return response.result;
    };
    const method = op => value => call(op, value);
    return Object.freeze({
      utf8: Object.freeze({decode: method('utf8.decode'), encode: method('utf8.encode')}),
      base64: Object.freeze({decode: method('base64.decode'), encode: method('base64.encode')}),
      yaml: Object.freeze({parse: method('yaml.parse')}),
    });
  })()`);
  const codec = setup.runInContext(context, { timeout: 50 });
  context.codec = codec;
  context.__inputJson = workerData.inputJson;
  const scriptTimeout = Math.max(1, Math.min(30_000, workerData.timeoutMs ?? 2000));
  const saveOutputBytes = Math.ceil(MAX_BYTES / 3) * 4;
  const maxOutputBytes = workerData.resultMode === 'general' ? 4096 : workerData.resultMode === 'credential-save' ? saveOutputBytes + 16 : 8 * 1024 * 1024;
  new vm.Script(workerData.source).runInContext(context, { timeout: scriptTimeout });
  const runner = new vm.Script(`(() => {
    const input = JSON.parse(globalThis.__inputJson);
    delete globalThis.__inputJson;
    const value = __run(input, globalThis.codec);
    if (value && typeof value.then === 'function') throw new Error('async scripts are not supported');
    const byteLength = text => {
      let bytes = 0;
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
        else bytes += 3;
      }
      return bytes;
    };
    const valid = ${workerData.resultMode === 'general'}
      ? (typeof value === 'boolean' || (value !== null && typeof value === 'object' && !Array.isArray(value)))
      : typeof value === 'string'
      ? byteLength(value) <= ${workerData.resultMode === 'credential-save' || workerData.resultMode === 'credential-load' ? Math.ceil(MAX_BYTES / 3) * 4 : MAX_BYTES}
      : value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).every(key => key === 'content' || key === 'encoding' || key === 'names') &&
        typeof value.content === 'string' &&
        (value.encoding === undefined || value.encoding === 'utf8' || value.encoding === 'base64' || value.encoding === 'parsed') &&
        byteLength(value.content) <= (${workerData.resultMode === 'credential-load' ? `value.encoding === 'base64' ? ${Math.ceil(MAX_BYTES / 3) * 4} : ${MAX_BYTES}` : MAX_BYTES}) &&
        (value.names === undefined || (Array.isArray(value.names) && value.names.length <= 1000 &&
          value.names.every(name => typeof name === 'string' && byteLength(name) <= 256)));
    if (!valid) throw new Error('invalid credential script output');
    return JSON.stringify(value);
  })()`);
  const result = runner.runInContext(context, { timeout: scriptTimeout });
  if (typeof result !== 'string') throw new Error('invalid credential script output');
  if (Buffer.byteLength(result) > maxOutputBytes) throw new Error('credential script output is too large');
  parentPort.postMessage(result);
} catch {
  parentPort.postMessage(null);
}
