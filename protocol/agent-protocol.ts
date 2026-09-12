/** Platform presentation contracts. App Server notifications are mapped to these
 * snapshots at the execution boundary; they are not the native RPC protocol. */
export type ItemStatus = 'in_progress' | 'completed' | 'failed';

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export type ThreadItem =
  | { id: string; type: 'agent_message'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | { id: string; type: 'command_execution'; command: string; aggregated_output: string; exit_code?: number; status: ItemStatus }
  | { id: string; type: 'file_change'; changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>; status: ItemStatus }
  | { id: string; type: 'mcp_tool_call'; server: string; tool: string; arguments: unknown;
      result?: { content: unknown[]; structured_content?: unknown; _meta?: unknown };
      error?: { message: string }; status: ItemStatus }
  | { id: string; type: 'web_search'; query: string }
  | { id: string; type: 'todo_list'; items: Array<{ text: string; completed: boolean }> }
  | { id: string; type: 'context_compaction'; status: ItemStatus }
  | { id: string; type: 'error'; message: string };

export type ThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started'; turn_id?: string }
  | { type: 'turn.completed'; usage: Usage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item: ThreadItem }
  | { type: 'error'; message: string };
