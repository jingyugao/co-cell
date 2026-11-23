import { useEffect, useRef, useState } from 'react';
import type { ViewerClient } from '@zrimo/viewer';
import type { WorkspaceFilePreview } from '../../../protocol/workspace-types';
import { errorMessage } from '../../lib/api';

const translations = {
  previous: '上一页', next: '下一页', page: '页', of: '/', zoomIn: '放大', zoomOut: '缩小',
  fitWidth: '适应宽度', fitPage: '整页', search: '搜索', searchPlaceholder: '搜索文档',
  matches: '个匹配', thumbnails: '缩略图', fullscreen: '全屏', exitFullscreen: '退出全屏',
  download: '下载原文件', sheets: '工作表', selectedRange: '选区', loading: '正在加载…',
  close: '关闭', noMatches: '没有匹配结果',
};

export function DocumentPreview({ file, url }: { file: WorkspaceFilePreview; url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const container = document.createElement('div');
    host.current!.append(container);
    let client: ViewerClient | undefined;
    setLoading(true);
    setError('');
    async function open() {
      const { ViewerClient } = await import('@zrimo/viewer');
      if (controller.signal.aborted) return;
      client = ViewerClient.create({ assetBaseUrl: '/vendor/zrimo/' });
      const viewer = client.createViewer({ container, ui: true, fit: 'width', translations });
      await viewer.load(url, { fileName: file.name, contentType: file.mimeType, signal: controller.signal });
    }
    void open().catch(reason => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => {
      controller.abort();
      container.remove();
      if (client) void client.destroy();
    };
  }, [file, url]);
  return <>
    {loading && <p role="status">正在加载文档…</p>}
    {error && <p role="alert">无法预览此文档，可下载原文件。{error}</p>}
    <div className="workspace-document" ref={host} hidden={Boolean(error)} />
  </>;
}
