import { Children, createContext, isValidElement, memo, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileContentUrl, fileViewUrl, resolveResource, type ResourceContext } from '../../lib/resource-links';

export type FileSelection = { path: string; line?: number; fragment?: string };
export type MarkdownResources = ResourceContext & { onOpenFile?: (file: FileSelection) => void };

const CodeBlockContext = createContext(false);
const LinkContext = createContext(false);
const localServiceHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);
function normalizeServiceUrl(href: string): string {
  return /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{1,5}(?:[/?#]|$)/i.test(href) ? 'http://' + href : href;
}
type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[]; data?: { hProperties?: Record<string, unknown> } };
function remarkHeadingIds({ prefix }: { prefix: string }) {
  return (tree: MarkdownNode) => {
    const counts = new Map<string, number>();
    const content = (node: MarkdownNode): string => node.value ?? node.children?.map(content).join('') ?? '';
    const walk = (node: MarkdownNode) => {
      if (node.type === 'heading') {
        const slug = content(node).toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
        const count = counts.get(slug) ?? 0; counts.set(slug, count + 1);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: prefix + slug + (count ? `-${count}` : '') } };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
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
export function MarkdownLink({ href, resources, children, ...props }: ComponentProps<'a'> & { resources: MarkdownResources }) {
  const resource = href ? resolveResource(href, resources) : null;
  let target = href ? defaultUrlTransform(href) : '';
  if (resource?.kind === 'file') target = fileViewUrl(resources.projectId!, resource.path, resource.line, resource.fragment);
  else if (resource?.kind === 'service') target = `/api/projects/${encodeURIComponent(resources.projectId!)}/preview?url=${encodeURIComponent(resource.href)}`;
  else if (resource?.kind === 'external' || resource?.kind === 'anchor') target = resource.href;
  // Unresolved local paths must never become accidental routes on the Web host.
  if (!resource && target && !/^(?:https?:|mailto:|tel:|#)/i.test(target)) target = '';
  return target ? <a {...props} href={target} title={resource?.kind === 'file' ? `查看文件：${resource.path}` : resource?.kind === 'service' ? `打开沙箱服务：${resource.href}` : props.title}
    {...(resource?.kind !== 'anchor' && !target.startsWith('#') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    onClick={event => {
      props.onClick?.(event);
      if (!event.defaultPrevented && resource?.kind === 'file' && resources.onOpenFile && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault(); resources.onOpenFile(resource);
      }
    }}><LinkContext.Provider value={true}>{children}</LinkContext.Provider></a> : <span title={href ? `无法定位资源：${href}` : undefined}>{children}</span>;
}
function MarkdownCode({ resources, children, ...props }: ComponentProps<'code'> & { resources: MarkdownResources }) {
  const inCodeBlock = useContext(CodeBlockContext);
  const inLink = useContext(LinkContext);
  let link: string | undefined;
  if (!inCodeBlock && !inLink && typeof children === 'string' && resolveResource(children, resources)) link = children;
  const code = <code {...props}>{children}</code>;
  return link ? <MarkdownLink href={link} resources={resources}>{code}</MarkdownLink> : code;
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
function Markdown({ text, projectId, workingDirectory, baseDirectory, onOpenFile }: { text: string } & MarkdownResources) {
  const id = useId();
  const renderers = useMemo<Components>(() => ({
    ...components,
    a: ({ node: _node, ...props }) => <MarkdownLink {...props}
      href={props.href?.startsWith('#') && !props.href.startsWith(`#markdown-${id}-`) ? `#markdown-${id}-${props.href.slice(1)}` : props.href}
      resources={{ projectId, workingDirectory, baseDirectory, onOpenFile }} />,
    code: ({ node: _node, ...props }) => <MarkdownCode {...props} resources={{ projectId, workingDirectory, baseDirectory, onOpenFile }} />,
    img: ({ node: _node, src, alt, ...props }) => {
      const resource = src ? resolveResource(src, { projectId, workingDirectory, baseDirectory }) : null;
      const target = resource?.kind === 'file' ? fileContentUrl(projectId!, resource.path)
        : resource?.kind === 'external' && /^https?:\/\//i.test(resource.href) ? resource.href : undefined;
      return target ? <img {...props} src={target} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" /> : <span>{alt || '无法定位图片'}</span>;
    },
  }), [id, projectId, workingDirectory, baseDirectory, onOpenFile]);
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkLocalServices, [remarkHeadingIds, { prefix: `markdown-${id}-` }]]} urlTransform={url => {
    // Custom file schemes are consumed by our renderers, never passed to the browser.
    if (resolveResource(url, { projectId, workingDirectory, baseDirectory })) return url;
    return defaultUrlTransform(normalizeServiceUrl(url));
  }} remarkRehypeOptions={{ clobberPrefix: `markdown-${id}-`, footnoteLabel: '注释', footnoteBackLabel: '返回正文' }} components={renderers}>{text}</ReactMarkdown></div>;
}

export default memo(Markdown);
