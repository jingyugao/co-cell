import { useState } from 'react';

const storageKey = 'codex-prompt-drafts';

function loadDrafts(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function saveDrafts(drafts: Record<string, string>) {
  try {
    if (Object.keys(drafts).length) localStorage.setItem(storageKey, JSON.stringify(drafts));
    else localStorage.removeItem(storageKey);
  } catch {
    // A blocked or full localStorage must not prevent the user from drafting.
  }
}

// Keep drafts separate across project/session switches and incoming events.
export function usePromptDraft(key: string) {
  const [drafts, setDrafts] = useState<Record<string, string>>(loadDrafts);
  const updateDrafts = (update: (current: Record<string, string>) => Record<string, string>) => setDrafts(current => {
    const next = update(current);
    saveDrafts(next);
    return next;
  });
  const prompt = drafts[key] ?? '';
  const setPrompt = (value: string) => updateDrafts(current => {
    const next = { ...current };
    if (value) next[key] = value;
    else delete next[key];
    return next;
  });
  const setSessionDraft = (id: string, value: string) => updateDrafts(current => {
    const draftKey = `session:${id}`;
    const next = { ...current };
    if (value) next[draftKey] = value;
    else delete next[draftKey];
    return next;
  });
  const moveToSession = (id: string) => updateDrafts(current => {
    const next = { ...current, [`session:${id}`]: current[key] ?? '' };
    delete next[key];
    return next;
  });
  return { prompt, setPrompt, setSessionDraft, moveToSession };
}
