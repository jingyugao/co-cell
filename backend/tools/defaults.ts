import type { DynamicToolInput } from '../../protocol/tool-types.js';
import type { ToolScript } from '../../protocol/tool-script-types.js';
import { additionalToolDefaults, additionalToolScriptDefaults } from './native-tool-defaults.js';

/** Native credential adapters remain responsible for parsing existing Secret files. */
export const isDynamicBuiltin = (name: string) => builtinToolDefaults.some(tool => tool.name === name);

export const mysqlToolScriptDefaults: Array<Omit<ToolScript, 'version' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'a3ecfbe4-782a-4db0-85cc-12f5b4a4d201', name: 'mysql permission', language: 'typescript',
    source: `const selected = input.args.find(arg => arg.startsWith('--login-path='))?.slice(13);
return { allow: selected === undefined || (input.permission.credentials ?? []).includes(selected),
  reason: '项目未授权此 MySQL login-path' };`,
  },
  {
    id: 'a3ecfbe4-782a-4db0-85cc-12f5b4a4d202', name: 'mysql credential parser', language: 'typescript',
    source: `const bytes = codec.base64.decode(input.content);
const loginFile = input.path.split('/').at(-1) === '.mylogin.cnf';
const loginFormat = bytes.length >= 24 && bytes.slice(0, 4).every(byte => byte === 0);
if (loginFile && loginFormat) return { content: codec.mysql.decode(input.content), encoding: 'parsed' };
try {
  const content = codec.utf8.decode(input.content);
  if (!content.includes('\\0')) return { content, encoding: 'utf8' };
} catch {}
return { content: input.content, encoding: 'base64' };`,
  },
  {
    id: 'a3ecfbe4-782a-4db0-85cc-12f5b4a4d203', name: 'mysql credential saver', language: 'typescript',
    source: `if (input.encoding === 'base64') return input.content;
if (input.path.split('/').at(-1) === '.mylogin.cnf') return codec.mysql.encode(input.content);
return codec.utf8.encode(input.content);`,
  },
];

const mysqlToolScripts = Object.fromEntries(mysqlToolScriptDefaults.map(script => [script.name, script])) as Record<string, typeof mysqlToolScriptDefaults[number]>;

export const mysqlToolDefault: DynamicToolInput = {
  name: 'mysql', description: 'MySQL 原生 login-path 客户端',
  instructions: 'mysql --login-path=<连接名> -e SQL；使用项目角色授权的连接名称。也支持 --help 和 --version。',
  enabled: true, executable: '/opt/cellbox/debug-bin/mysql', args: ['--no-defaults'],
  env: { MYSQL_TEST_LOGIN_FILE: '${CREDENTIAL}' }, credentialPath: '.mylogin.cnf', timeoutMs: 20000,
  credentialPaths: ['.mylogin.cnf', '.my.cnf'],
  permissionScriptId: mysqlToolScripts['mysql permission'].id,
  credentialParseScriptId: mysqlToolScripts['mysql credential parser'].id,
  credentialSaveScriptId: mysqlToolScripts['mysql credential saver'].id,
};

export const builtinToolDefaults = [mysqlToolDefault, ...additionalToolDefaults];
export const builtinToolScriptDefaults = [...mysqlToolScriptDefaults, ...additionalToolScriptDefaults];
export const builtinToolDefault = (name: string) => builtinToolDefaults.find(tool => tool.name === name);
