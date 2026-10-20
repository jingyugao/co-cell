import mermaid from 'mermaid';

// Diagram text can configure appearance, but cannot relax these site settings.
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  theme: 'neutral',
  themeCSS: '',
  fontFamily: 'system-ui, sans-serif',
  suppressErrorRendering: true,
  maxTextSize: 50_000,
  maxEdges: 500,
  secure: ['secure', 'securityLevel', 'startOnLoad', 'htmlLabels', 'themeCSS', 'fontFamily',
    'suppressErrorRendering', 'maxTextSize', 'maxEdges'],
});

let renderId = 0;

export async function renderMermaid(source: string): Promise<string> {
  // Keep Mermaid's temporary measurement DOM out of React-owned elements.
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;';
  document.body.append(container);
  try {
    const { svg } = await mermaid.render(`mermaid-${++renderId}`, source, container);
    return svg;
  } finally {
    container.remove();
  }
}
