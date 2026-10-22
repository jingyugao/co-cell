import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './EditorDialog.css';

type Props = { title: string; busy: boolean; error?: string; onClose: () => void; children: ReactNode };

export default function EditorDialog({ title, busy, error, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')?.focus();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  function dismiss() { if (!busy) onClose(); }

  return createPortal(<dialog ref={ref} className="connection-editor-dialog" aria-labelledby={titleId} aria-modal="true" aria-busy={busy}
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onPointerDown={event => { if (event.target === event.currentTarget) dismiss(); }}>
    <header className="connection-editor-heading"><h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label="关闭编辑窗口" disabled={busy} onClick={dismiss}>×</button>
    </header>
    <div className="connection-editor-body">
      {error && <p className="connections-error" role="alert">{error}</p>}
      <fieldset className="connection-editor-content" disabled={busy}>{children}</fieldset>
    </div>
  </dialog>, document.body);
}
