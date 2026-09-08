import type { ReactNode } from 'react';

type IconName = 'plus' | 'chat' | 'folder' | 'chevron' | 'settings' | 'panel' | 'arrow' | 'attach' | 'close' | 'terminal' | 'check' | 'globe' | 'code' | 'branch' | 'stop' | 'menu' | 'refresh' | 'trash';
const paths: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />, chat: <path d="M5 4h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 3V6a2 2 0 0 1 2-2Z" />,
  folder: <path d="M3 7V5h6l2 2h10v13H3V7Z" />, chevron: <path d="m9 5 7 7-7 7" />, settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></>, arrow: <path d="M12 19V5m-6 6 6-6 6 6" />, attach: <path d="m9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8" />,
  close: <path d="m6 6 12 12M6 18 18 6" />, terminal: <><path d="m5 7 5 5-5 5M13 17h6" /></>, check: <path d="m5 12 4 4L19 6" />, globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
  code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" /></>, branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10m12-10c0 6-12 2-12 8" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />, menu: <path d="M4 6h16M4 12h16M4 18h16" />, refresh: <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" /></>, trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></>,
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>; }
export function Mark({ small = false }: { small?: boolean }) { return <span className={`codex-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><path d="m18 10-13 14 13 14M30 10l13 14-13 14M28 6 20 42" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>; }
