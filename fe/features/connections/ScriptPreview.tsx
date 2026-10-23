import { useState } from 'react';
import type { DynamicTool } from '../../../protocol/tool-types';
import type { ToolScript } from '../../../protocol/tool-script-types';
import EditorDialog from './EditorDialog';
import { scriptUsages } from './tool-script-context';
import type { ScriptBinding } from './tool-script-context';
import './ScriptPreview.css';

type Props = { script: ToolScript; tools: DynamicTool[]; onClose: () => void; context?: ScriptBinding; toolName?: string; referencesKnown?: boolean };

export default function ScriptPreview({ script, tools, onClose, context, toolName, referencesKnown = true }: Props) {
  const [copyStatus, setCopyStatus] = useState('');
  const usages = scriptUsages(script.id, tools);
  async function copy() {
    try { await navigator.clipboard.writeText(script.source); setCopyStatus('代码已复制。'); }
    catch { setCopyStatus('复制失败，请选中代码后复制。'); }
  }
  return <EditorDialog title={`查看脚本：${script.name}`} busy={false} onClose={onClose}>
    <div className="script-preview">
      <div className="script-preview-meta"><span>{script.language === 'bash' ? 'Bash' : 'TypeScript'}</span><span>v{script.version}</span><span>只读预览</span></div>
      {context && <section className="script-preview-context" aria-label="当前脚本用途">
        <h3>{toolName ? `${toolName} · ` : ''}{context.label}</h3>
        <p><strong>触发时机：</strong>{context.trigger}</p><p>{context.description}</p>
      </section>}
      <section className="script-preview-references" aria-label="脚本引用关系"><h3>引用此脚本的工具</h3>
        {!referencesKnown ? <p>引用关系尚未加载，请在脚本管理中刷新后确认。</p> : usages.length ? <ul>{usages.map(({ tool, binding }) =>
          <li key={`${tool.name}-${binding.field}`}><strong>{tool.name}</strong><span>{binding.label}</span><span>{binding.trigger}{!tool.enabled ? ' · 工具已停用' : ''}</span></li>)}</ul>
          : <p>暂无已保存的工具引用。选择脚本后，需要保存工具才能生效。</p>}
      </section>
      <div className="script-preview-source-heading"><h3>脚本源码</h3><button type="button" className="secondary-button" onClick={() => void copy()}>复制代码</button></div>
      <pre className="script-preview-source" role="region" tabIndex={0} aria-label="脚本源码"><code>{script.source}</code></pre>
      {copyStatus && <p role="status" className="tool-permission-help">{copyStatus}</p>}
      <div className="secret-actions"><button type="button" className="secondary-button" onClick={onClose}>关闭预览</button></div>
    </div>
  </EditorDialog>;
}
