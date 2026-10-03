import type { Turn } from '../protocol/types.js';

/** Format complete native async replies for display without changing the agent input. */
export function userInputReplyDisplayText(prompt: string): string {
  let text = prompt.trim();
  if (text.startsWith('# Context from my IDE setup:\n')) {
    const delimiter = '\n## My request for Codex:\n';
    const index = text.lastIndexOf(delimiter);
    if (index < 0) return prompt;
    text = text.slice(index + delimiter.length).trim();
  }
  const start = '<send_user_message_question_reply>';
  const end = '</send_user_message_question_reply>';
  if (!text.startsWith(start) || !text.endsWith(end)) return prompt;
  try {
    const value: unknown = JSON.parse(text.slice(start.length, -end.length));
    const replies: unknown[] = Array.isArray(value) ? value : [value];
    if (!replies.length) return prompt;
    const formatted: string[] = [];
    for (const reply of replies) {
      if (!reply || typeof reply !== 'object'
        || !('questionItemId' in reply) || typeof reply.questionItemId !== 'string'
        || !('question' in reply) || typeof reply.question !== 'string'
        || !('answer' in reply) || typeof reply.answer !== 'string') return prompt;
      formatted.push(`> ${reply.question}\n\n${reply.answer}`);
    }
    return formatted.join('\n\n');
  } catch {
    return prompt;
  }
}

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
