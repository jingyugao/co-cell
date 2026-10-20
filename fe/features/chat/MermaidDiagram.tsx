import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

type RenderResult = { source: string; svg?: string; error?: string };

export function MermaidDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  const [result, setResult] = useState<RenderResult | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const current = result?.source === source ? result : null;
  useEffect(() => {
    let cancelled = false;
    // Let streaming code settle before parsing another diagram.
    const timer = setTimeout(() => {
      void import('./mermaid-renderer').then(async ({ renderMermaid }) => {
        if (cancelled) return;
        const svg = await renderMermaid(source);
        if (!cancelled) setResult({ source, svg });
      }).catch(error => {
        if (!cancelled) setResult({ source, error: error instanceof Error ? error.message : '无法渲染此图表' });
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [source]);
  useLayoutEffect(() => {
    const svg = container.current?.querySelector('svg');
    if (!svg) return;
    // Preserve readable diagram dimensions instead of shrinking a large graph to fit.
    const width = svg.viewBox.baseVal.width;
    if (width > 0) svg.style.width = `${width}px`;
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
  }, [current?.svg]);

  if (current?.error) return <>
    <div className="markdown-mermaid-error" role="status"><strong>Mermaid 图表渲染失败</strong><p>{current.error}</p></div>
    {fallback}
  </>;
  if (!current?.svg) return <div className="markdown-mermaid-status" role="status">正在绘制图表…</div>;
  // Only Mermaid's strict-mode sanitized SVG enters the DOM, never the source text.
  return <div ref={container} className="markdown-mermaid-diagram" role="region" aria-label="Mermaid 图表" tabIndex={0}
    dangerouslySetInnerHTML={{ __html: current.svg }} />;
}
