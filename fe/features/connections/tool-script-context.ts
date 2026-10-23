import type { DynamicTool } from '../../../protocol/tool-types';

export type ScriptBinding = {
  field: 'permissionScriptId' | 'credentialParseScriptId' | 'credentialSaveScriptId';
  label: string;
  trigger: string;
  description: string;
  fallback: string;
};

export const SCRIPT_BINDINGS: readonly ScriptBinding[] = [
  {
    field: 'permissionScriptId', label: '权限检查', trigger: '每次调用工具时',
    description: '根据本次命令和项目角色决定是否允许执行。命名凭据模式还要选出本次使用的凭据名称，由后端核对授权。',
    fallback: '未配置 · 仅检查项目角色授权',
  },
  {
    field: 'credentialParseScriptId', label: '凭据读取', trigger: '打开凭据文件或读取命名凭据列表时',
    description: '把原始凭据转换为可查看的内容；命名凭据模式还会提取可授权的连接或账号名称。',
    fallback: '未配置 · 直接读取原始文件',
  },
  {
    field: 'credentialSaveScriptId', label: '凭据保存', trigger: '保存凭据文件时',
    description: '把编辑后的内容转换回工具需要的格式，例如加密文件。配置后每次保存都会执行。',
    fallback: '未配置 · 直接保存原始文本或二进制',
  },
];

export function scriptUsages(scriptId: string, tools: DynamicTool[]) {
  return tools.flatMap(tool => SCRIPT_BINDINGS.filter(binding => tool[binding.field] === scriptId).map(binding => ({ tool, binding })));
}
