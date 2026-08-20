import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";

import { tool } from "langchain";
import { z } from "zod";

const QuestionOptionSchema = z.object({
  label: z.string().trim().min(1).describe("User-facing label (1-5 words)."),
  description: z
    .string()
    .trim()
    .min(1)
    .describe("One short sentence explaining impact/tradeoff if selected."),
});

const QuestionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "id must be snake_case")
    .describe("Stable identifier for mapping answers (snake_case)."),
  header: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .describe("Short header label shown in the UI (12 or fewer chars)."),
  question: z.string().trim().min(1).describe("Single-sentence prompt shown to the user."),
  options: z
    .array(QuestionOptionSchema)
    .min(2)
    .max(3)
    .describe(
      "Provide 2-3 mutually exclusive choices. Put the recommended option first " +
        "and suffix its label with '(Recommended)'. Do not include an Other option.",
    ),
});

const RequestUserInputSchema = z.object({
  questions: z
    .array(QuestionSchema)
    .min(1)
    .max(3)
    .describe("Questions to show the user. Prefer 1 and do not exceed 3."),
});

export type UserInputQuestion = z.infer<typeof QuestionSchema>;
export type RequestUserInput = z.infer<typeof RequestUserInputSchema>;
export interface RequestUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}
export type RequestUserInputHandler = (
  request: RequestUserInput,
) => Promise<RequestUserInputResponse>;

export function createRequestUserInputTool(handler: RequestUserInputHandler) {
  return tool(async (input: RequestUserInput) => JSON.stringify(await handler(input)), {
    name: "request_user_input",
    description:
      "Request user input for one to three short questions and wait for the response. " +
      "Use this when a missing decision materially changes the implementation, or when " +
      "the task is blocked and leader input is required.",
    schema: RequestUserInputSchema,
  });
}

function terminalStreams(): {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  close: () => void;
} {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return { input: process.stdin, output: process.stdout, close: () => undefined };
  }
  if (process.platform === "win32") {
    throw new Error("Interactive input requires a TTY when running on Windows");
  }
  const input = createReadStream("/dev/tty");
  const output = createWriteStream("/dev/tty");
  return {
    input,
    output,
    close: () => {
      input.destroy();
      output.end();
    },
  };
}

export function createTerminalUserInputHandler(): RequestUserInputHandler {
  return async ({ questions }) => {
    const streams = terminalStreams();
    const readline = createInterface({ input: streams.input, output: streams.output });
    const answers: RequestUserInputResponse["answers"] = {};
    try {
      for (const question of questions) {
        streams.output.write(`\n[${question.header}] ${question.question}\n`);
        question.options.forEach((option, index) => {
          streams.output.write(
            `  ${index + 1}. ${option.label} — ${option.description}\n`,
          );
        });
        streams.output.write("  0. Other (free-form)\n");
        const raw = (await readline.question("> ")).trim();
        const optionIndex = Number(raw);
        let selected =
          Number.isInteger(optionIndex) &&
          optionIndex >= 1 &&
          optionIndex <= question.options.length
            ? question.options[optionIndex - 1]?.label
            : raw;
        if (raw === "0") selected = (await readline.question("Other: ")).trim();
        if (!selected) throw new Error(`No answer provided for ${question.id}`);
        answers[question.id] = { answers: [selected] };
      }
      return { answers };
    } finally {
      readline.close();
      streams.close();
    }
  };
}
