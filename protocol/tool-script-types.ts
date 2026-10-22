export type ToolScriptLanguage = 'typescript' | 'bash';

export interface ToolScript {
  id: string;
  name: string;
  language: ToolScriptLanguage;
  source: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ToolScriptInput {
  name: string;
  language: ToolScriptLanguage;
  source: string;
}
