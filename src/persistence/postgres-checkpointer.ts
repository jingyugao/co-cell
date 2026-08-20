import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export interface PostgresCheckpointerOptions {
  connectionString: string;
  schema?: string;
  setup?: boolean;
}

export interface PostgresCheckpointerHandle {
  checkpointer: PostgresSaver;
  close(): Promise<void>;
}

/** Create and initialize the official LangGraph PostgreSQL checkpointer. */
export async function createPostgresCheckpointer(
  options: PostgresCheckpointerOptions,
): Promise<PostgresCheckpointerHandle> {
  const connectionString = options.connectionString.trim();
  if (!connectionString) {
    throw new Error("PostgreSQL checkpoint connection string must not be empty");
  }

  const schema = options.schema?.trim();
  const checkpointer = PostgresSaver.fromConnString(
    connectionString,
    schema ? { schema } : undefined,
  );
  try {
    if (options.setup ?? true) await checkpointer.setup();
  } catch (error) {
    await checkpointer.end();
    throw error;
  }

  return {
    checkpointer,
    close: () => checkpointer.end(),
  };
}
