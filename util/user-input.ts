import type { Turn } from '../protocol/types.js';

/** Derive native async questions for both live events and reloaded history. */
export function withNativeUserInput(turn: Turn): Turn {
  const requests = [...(turn.userInputRequests ?? [])];
  for (const item of turn.items) {
    if (item.type !== 'agent_message' || item.delivery !== 'async' || !item.questions?.length) continue;
    if (!requests.some(request => request.id === item.id)) requests.push({
      id: item.id, questions: item.questions, status: 'pending',
      createdAt: turn.itemTimestamps?.[item.id] ?? turn.startedAt,
    });
  }
  return requests.length ? { ...turn, userInputRequests: requests } : turn;
}
