import { Children, isValidElement, memo, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children).find(value => isValidElement(value));
  const code = isValidElement<{ children?: ReactNode; className?: string }>(child) ? child : undefined;
  const content = typeof code?.props.children === 'string' ? code.props.children : '';
  const language = code?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(content); setCopyState('copied'); }
    catch { setCopyState('failed'); }
    timer.current = setTimeout(() => setCopyState('idle'), 2000);
  }
  return <div className="markdown-code-block"><div className="markdown-code-header"><span>{language || '代码'}</span><button type="button" onClick={() => void copy()} aria-label="复制代码"><span aria-live="polite">{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，请重试' : '复制代码'}</span></button></div><pre tabIndex={0}>{children}</pre></div>;
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ node: _node, ...props }) => <div className="markdown-table" role="region" aria-label="表格" tabIndex={0}><table {...props} /></div>,
  a: ({ node: _node, href, children, ...props }) => href
    ? <a {...props} href={href} {...(/^(https?:)?\/\//i.test(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>
    : <span>{children}</span>,
  img: ({ node: _node, src, alt, ...props }) => src
    ? <img {...props} src={src} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" />
    : <span>{alt}</span>,
};

/** Standard Markdown + GFM; raw HTML stays text and unsafe URL schemes are filtered. */
function Markdown({ text }: { text: string }) {
  const id = useId();
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} remarkRehypeOptions={{ clobberPrefix: `markdown-${id}-`, footnoteLabel: '注释', footnoteBackLabel: '返回正文' }} components={components}>{text}</ReactMarkdown></div>;
}

export default memo(Markdown);
