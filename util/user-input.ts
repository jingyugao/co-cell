import type { Turn } from '../protocol/types.js';

type QuestionReply = { questionItemId: string; question: string; answer: string };
type NativeAnswer = QuestionReply & { answeredAt: string; answerTurnId: string };
export type NativeUserInputAnswers = Map<string, NativeAnswer>;

function parseQuestionReplies(prompt: string): QuestionReply[] | null {
  let text = prompt.trim();
  if (text.startsWith('# Context from my IDE setup:\n')) {
    const delimiter = '\n## My request for Codex:\n';
    const index = text.lastIndexOf(delimiter);
    if (index < 0) return null;
    text = text.slice(index + delimiter.length).trim();
  }
  const start = '<send_user_message_question_reply>';
  const end = '</send_user_message_question_reply>';
  if (!text.startsWith(start) || !text.endsWith(end)) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start.length, -end.length));
    const replies: unknown[] = Array.isArray(value) ? value : [value];
    if (!replies.length) return null;
    const parsed: QuestionReply[] = [];
    for (const reply of replies) {
      if (!reply || typeof reply !== 'object'
        || !('questionItemId' in reply) || typeof reply.questionItemId !== 'string'
        || !('question' in reply) || typeof reply.question !== 'string'
        || !('answer' in reply) || typeof reply.answer !== 'string') return null;
      parsed.push({ questionItemId: reply.questionItemId, question: reply.question, answer: reply.answer });
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Format complete native async replies for display without changing the agent input. */
export function userInputReplyDisplayText(prompt: string): string {
  return parseQuestionReplies(prompt)?.map(reply => `> ${reply.question}\n\n${reply.answer}`).join('\n\n') ?? prompt;
}

/** Index only replies already accepted into native history, including newer pages. */
export function collectNativeUserInputAnswers(turns: Turn[], answers: NativeUserInputAnswers): void {
  for (const turn of turns) {
    if (!turn.codexAccepted) continue;
    for (const input of [turn.prompt, ...(turn.additionalUserInputs ?? [])]) {
      for (const reply of parseQuestionReplies(input) ?? []) {
        try {
          const key: unknown = JSON.parse(reply.questionItemId);
          if (!Array.isArray(key) || key.length !== 3 || key[0] !== 'request_user_input_async'
            || typeof key[1] !== 'string' || !Number.isInteger(key[2]) || key[2] < 0) continue;
          const id = JSON.stringify(key);
          if (!answers.has(id) || answers.get(id)!.answeredAt < turn.startedAt) {
            answers.set(id, { ...reply, answeredAt: turn.startedAt, answerTurnId: turn.id });
          }
        } catch { /* Ordinary user text cannot resolve an async question. */ }
      }
    }
  }
}

/** Derive native async questions for both live events and reloaded history. */
export function withNativeUserInput(turn: Turn, answers?: NativeUserInputAnswers): Turn {
  const requests = [...(turn.userInputRequests ?? [])];
  for (const item of turn.items) {
    if (item.type !== 'agent_message' || item.delivery !== 'async' || !item.questions?.length) continue;
    if (!requests.some(request => request.id === item.id)) requests.push({
      id: item.id, questions: item.questions, status: 'pending',
      createdAt: turn.itemTimestamps?.[item.id] ?? turn.startedAt,
    });
  }
  return requests.length ? { ...turn, userInputRequests: requests.map(request => {
    const replies = request.questions.map((question, index) => {
      const reply = answers?.get(JSON.stringify(['request_user_input_async', request.id, index]));
      return reply?.question === question.title
        && (reply.answeredAt >= request.createdAt || reply.answerTurnId === turn.id || reply.answerTurnId === turn.nativeTurnId) ? reply : undefined;
    });
    if (!replies.length || replies.some(reply => !reply)) return request;
    const values = replies.map(reply => reply!.answer);
    const latest = replies.reduce((left, right) => left!.answeredAt > right!.answeredAt ? left : right)!;
    return { ...request, status: 'answered' as const, answers: values,
      answer: values.length === 1 ? values[0] : values.map((value, index) => `${index + 1}. ${request.questions[index].title}\n${value}`).join('\n\n'),
      answeredAt: latest.answeredAt, answerTurnId: latest.answerTurnId };
  }) } : turn;
}
