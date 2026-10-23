const labels: Record<string, string> = {
  cmd: '命令', command: '命令', cwd: '工作目录', workdir: '工作目录',
  input: '输入', output: '输出', stdout: '标准输出', stderr: '错误输出',
  exit_code: '退出码', exitCode: '退出码', status: '状态', error: '错误', reason: '原因',
  prompt: '任务说明', message: '消息', text: '正文', content: '内容',
  questions: '问题', question: '问题', answers: '回答', answer: '回答',
  title: '标题', options: '选项', description: '说明',
  task_name: '子任务', target: '接收方', model: '模型', result: '结果', value: '结果',
};
const literalKeys = /^(?:cmd|command|code|patch|diff)$/;
const textTypes = new Set(['text', 'input_text', 'output_text']);
const executionMetadata = new Set(['chunk_id', 'session_id', 'wall_time_seconds', 'original_token_count']);

export function codeFence(text: string, language = 'text'): string {
  let width = 3;
  for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
  const marker = '`'.repeat(width);
  return `${marker}${language}\n${text}\n${marker}`;
}

/** Decode complete JSON containers only; never unescape arbitrary prose or source code. */
export function structuredValue(text: string): unknown {
  if (!/^\s*[\[{]/.test(text)) return text;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? value : text;
  } catch { return text; }
}

function outputText(text: string): string {
  // This header is emitted by functions.exec before its actual content blocks.
  return text.replace(/^Script completed\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n?/, '');
}

function transportValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(transportValue);
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return textTypes.has(String(item.type)) && typeof item.text === 'string'
    || Array.isArray(item.content) && item.content.length > 0 && item.content.every(transportValue)
    || item.status === 'fulfilled' && 'value' in item
    || 'output' in item && ('wall_time_seconds' in item || 'exit_code' in item || 'original_token_count' in item);
}

const indent = (text: string) => text.split('\n').map(line => line ? `  ${line}` : '').join('\n');
const label = (key: string) => (labels[key] ?? key).replace(/[\\`*_\[\]<>]/g, '\\$&');

/** Tool transport containers become Markdown fields; authored strings remain fenced text. */
export function materialValue(value: unknown, language = 'text', depth = 0): string {
  if (value === undefined || value === '') return '';
  if (value === null) return 'null';
  if (depth > 64) throw new Error('工具内容的嵌套层级超过 64 层');
  if (typeof value === 'string') {
    const text = outputText(value);
    const parsed = structuredValue(text);
    if (parsed !== text) return transportValue(parsed)
      ? materialValue(parsed, language, depth + 1) : codeFence(text, 'json');
    // Truncation warnings can precede otherwise complete JSON result lines.
    const lines = text.split('\n').map(line => ({ text: line, value: structuredValue(line) }));
    if (lines.some(line => transportValue(line.value))) {
      const parts: string[] = [], plain: string[] = [];
      const flush = () => { if (plain.length) { parts.push(codeFence(plain.join('\n'), language)); plain.length = 0; } };
      for (const line of lines) {
        if (transportValue(line.value)) { flush(); parts.push(materialValue(line.value, language, depth + 1)); }
        else plain.push(line.text);
      }
      flush();
      return parts.join('\n\n');
    }
    return text ? codeFence(text, language) : '';
  }
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return '（空列表）';
    const blocks = value.every(item => item && typeof item === 'object' && textTypes.has(String(item.type)));
    return value.map((item, index) => {
      const text = materialValue(item, language, depth + 1);
      return text ? (blocks ? text : `${index + 1}. ${indent(text).trimStart()}`) : '';
    }).filter(Boolean).join('\n\n');
  }
  const object = value as Record<string, unknown>;
  if (!Object.keys(object).length) return '（空对象）';
  if (textTypes.has(String(object.type)) && typeof object.text === 'string')
    return materialValue(object.text, language, depth + 1);
  if (object.status === 'fulfilled' && 'value' in object && Object.keys(object).every(key => ['status', 'value'].includes(key)))
    return materialValue(object.value, language, depth + 1);
  const execution = 'output' in object && ('wall_time_seconds' in object || 'exit_code' in object || 'original_token_count' in object);
  const fields: string[] = [];
  for (const [key, item] of Object.entries(object)) {
    if (execution && executionMetadata.has(key)) continue;
    if (item === '') { fields.push(`- **${label(key)}**：（空字符串）`); continue; }
    if (typeof item === 'number' || typeof item === 'boolean') {
      fields.push(`- **${label(key)}**：${item}`);
      continue;
    }
    if (typeof item === 'string' && item && item.length <= 160 && !/[\r\n`]/.test(item)
      && !literalKeys.test(key) && !/^(?:output|stdout|stderr|text|content)$/.test(key) && structuredValue(item) === item) {
      fields.push(`- **${label(key)}**：${item}`);
      continue;
    }
    const text = literalKeys.test(key) && typeof item === 'string'
      ? codeFence(item, key === 'cmd' || key === 'command' ? 'sh' : 'text')
      : materialValue(item, language, depth + 1);
    if (text) fields.push(`- **${label(key)}**\n\n${indent(text)}`);
  }
  return fields.join('\n\n');
}

export function questionReply(text: string): string {
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!match) return text;
  const parsed = structuredValue(match[1]);
  if (!Array.isArray(parsed) || !parsed.every(item => item && typeof item === 'object' && 'answer' in item)) return text;
  return parsed.map(item => [
    typeof item.question === 'string' ? `问题：${item.question}` : '',
    `回答：${typeof item.answer === 'string' ? item.answer : materialValue(item.answer)}`,
  ].filter(Boolean).join('\n\n')).join('\n\n');
}
