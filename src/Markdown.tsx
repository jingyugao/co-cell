import { Children, createContext, isValidElement, memo, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const CodeBlockContext = createContext(false);
const LinkContext = createContext(false);
const localServiceHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);
function normalizeServiceUrl(href: string): string {
  return /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{1,5}(?:[/?#]|$)/i.test(href) ? 'http://' + href : href;
}
type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };
function remarkLocalServices() {
  const walk = (node: MarkdownNode) => {
    if (!node.children || ['link', 'linkReference', 'code', 'inlineCode', 'html'].includes(node.type)) return;
    node.children = node.children.flatMap(child => {
      if (child.type !== 'text' || !child.value) { walk(child); return [child]; }
      const text = child.value;
      const pattern = /(?<![a-zA-Z0-9_./:@-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{1,5}(?![\w:])(?:[/?#][^\s<>()[\]"'`，。；！？、]*)?/gi;
      const nodes: MarkdownNode[] = []; let offset = 0;
      for (const match of text.matchAll(pattern)) {
        const value = match[0].replace(/[.,;!?]+$/, '');
        const href = normalizeServiceUrl(value);
        try { const url = new URL(href); if (!localServiceHosts.has(url.hostname) || url.port === '0') continue; } catch { continue; }
        if (match.index > offset) nodes.push({ type: 'text', value: text.slice(offset, match.index) });
        nodes.push({ type: 'link', url: href, children: [{ type: 'text', value }] });
        offset = match.index + value.length;
      }
      if (!nodes.length) return [child];
      if (offset < text.length) nodes.push({ type: 'text', value: text.slice(offset) });
      return nodes;
    });
  };
  return walk;
}
function serviceLink(href: string, projectId?: string): string {
  if (!projectId || !/^https?:\/\//i.test(href)) return href;
  try {
    const url = new URL(href);
    if (localServiceHosts.has(url.hostname)) return `/api/projects/${encodeURIComponent(projectId)}/preview?url=${encodeURIComponent(href)}`;
  } catch { /* Preserve malformed links for the standard Markdown renderer. */ }
  return href;
}
function MarkdownLink({ href, projectId, children, ...props }: ComponentProps<'a'> & { projectId?: string }) {
  href = href ? normalizeServiceUrl(href) : href;
  return href ? <a {...props} href={serviceLink(href, projectId)} {...(/^(https?:)?\/\//i.test(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}><LinkContext.Provider value={true}>{children}</LinkContext.Provider></a> : <span>{children}</span>;
}
function MarkdownCode({ projectId, children, ...props }: ComponentProps<'code'> & { projectId?: string }) {
  const inCodeBlock = useContext(CodeBlockContext);
  const inLink = useContext(LinkContext);
  let link: string | undefined;
  if (!inCodeBlock && !inLink && typeof children === 'string' && /^https?:\/\/\S+$/i.test(normalizeServiceUrl(children))) {
    try { const url = new URL(normalizeServiceUrl(children)); if (url.protocol === 'http:' || url.protocol === 'https:') link = normalizeServiceUrl(children); } catch { /* Keep non-URL code unchanged. */ }
  }
  const code = <code {...props}>{children}</code>;
  return link ? <MarkdownLink href={link} projectId={projectId}>{code}</MarkdownLink> : code;
}

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
  return <div className="markdown-code-block"><div className="markdown-code-header"><span>{language || '代码'}</span><button type="button" onClick={() => void copy()} aria-label="复制代码"><span aria-live="polite">{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，请重试' : '复制代码'}</span></button></div><pre tabIndex={0}><CodeBlockContext.Provider value={true}>{children}</CodeBlockContext.Provider></pre></div>;
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ node: _node, ...props }) => <div className="markdown-table" role="region" aria-label="表格" tabIndex={0}><table {...props} /></div>,
  img: ({ node: _node, src, alt, ...props }) => src
    ? <img {...props} src={src} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" />
    : <span>{alt}</span>,
};

/** Standard Markdown + GFM; raw HTML stays text and unsafe URL schemes are filtered. */
function Markdown({ text, projectId }: { text: string; projectId?: string }) {
  const id = useId();
  const renderers = useMemo<Components>(() => ({
    ...components,
    a: ({ node: _node, ...props }) => <MarkdownLink {...props} projectId={projectId} />,
    code: ({ node: _node, ...props }) => <MarkdownCode {...props} projectId={projectId} />,
  }), [projectId]);
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkLocalServices]} urlTransform={url => defaultUrlTransform(normalizeServiceUrl(url))} remarkRehypeOptions={{ clobberPrefix: `markdown-${id}-`, footnoteLabel: '注释', footnoteBackLabel: '返回正文' }} components={renderers}>{text}</ReactMarkdown></div>;
}

export default memo(Markdown);
