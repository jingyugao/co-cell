import { useState } from 'react';

// Keep drafts separate across project/session switches and incoming events.
export function usePromptDraft(key: string) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const prompt = drafts[key] ?? '';
  const setPrompt = (value: string) => setDrafts(current => ({ ...current, [key]: value }));
  const setSessionDraft = (id: string, value: string) => setDrafts(current => ({ ...current, [`session:${id}`]: value }));
  const moveToSession = (id: string) => setDrafts(current => {
    const next = { ...current, [`session:${id}`]: prompt };
    delete next[key];
    return next;
  });
  return { prompt, setPrompt, setSessionDraft, moveToSession };
}
