import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';

type DraftStatus = { dirty: boolean; busy: boolean };
export type DraftAggregate = DraftStatus;
type DraftGuard = {
  set: (id: string, status: DraftStatus) => void;
  clear: (id: string) => void;
  canLeave: (ids?: string[]) => boolean;
};
const Context = createContext<DraftGuard | null>(null);

export function DraftGuardProvider({ children, onStatusChange }: { children: ReactNode; onStatusChange?: (status: DraftAggregate) => void }) {
  const drafts = useRef(new Map<string, DraftStatus>());
  const report = useCallback(() => onStatusChange?.({
    dirty: [...drafts.current.values()].some(status => status.dirty),
    busy: [...drafts.current.values()].some(status => status.busy),
  }), [onStatusChange]);
  const guard = useMemo<DraftGuard>(() => ({
    set: (id, status) => { drafts.current.set(id, status); report(); },
    clear: id => { drafts.current.delete(id); report(); },
    canLeave: ids => {
      const statuses = ids ? ids.map(id => drafts.current.get(id)).filter((value): value is DraftStatus => Boolean(value)) : [...drafts.current.values()];
      if (statuses.some(status => status.busy)) {
        window.alert('正在读取或保存，请稍候再切换。');
        return false;
      }
      return !statuses.some(status => status.dirty) || window.confirm('当前有未保存的修改。离开并丢弃这些修改吗？');
    },
  }), [report]);

  useEffect(() => { report(); return () => onStatusChange?.({ dirty: false, busy: false }); }, [report, onStatusChange]);

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (![...drafts.current.values()].some(status => status.dirty || status.busy)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, []);

  return <Context.Provider value={guard}>{children}</Context.Provider>;
}

export function useDraftGuard() { return useContext(Context); }

export function useDraftStatus(id: string, dirty: boolean, busy: boolean) {
  const guard = useDraftGuard();
  useEffect(() => {
    guard?.set(id, { dirty, busy });
    return () => guard?.clear(id);
  }, [guard, id, dirty, busy]);
  return guard;
}
