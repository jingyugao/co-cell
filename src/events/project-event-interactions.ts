import type { Pool } from "pg";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export interface ProjectEventReplyContext {
  inboxEventId: string;
  projectId: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ExternalEventReplyAdapter {
  readonly source: string;
  supports(context: ProjectEventReplyContext): boolean;
  reply(context: ProjectEventReplyContext, content: string): Promise<{
    providerReplyId?: string;
  }>;
}

export interface ProjectEventInteractionResult {
  id: string;
  inboxEventId: string;
  action: "reply" | "defer";
  status: "pending" | "sent" | "deferred" | "failed" | "superseded";
  content: string;
  providerReplyId: string | null;
  errorMessage: string | null;
}

interface InteractionActor {
  projectId: string;
  agentSeatId: string;
  runId: string;
  inboxEventId: string;
}

interface InteractionRow {
  id: string;
  inbox_event_id: string;
  action: "reply" | "defer";
  status: "pending" | "sent" | "deferred" | "failed" | "superseded";
  content: string;
  provider_reply_id: string | null;
  error_message: string | null;
}

function result(row: InteractionRow): ProjectEventInteractionResult {
  return {
    id: row.id,
    inboxEventId: row.inbox_event_id,
    action: row.action,
    status: row.status,
    content: row.content,
    providerReplyId: row.provider_reply_id,
    errorMessage: row.error_message,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PostgresProjectEventInteractions {
  private readonly adapters: Map<string, ExternalEventReplyAdapter[]>;

  constructor(
    private readonly pool: Pool,
    adapters: readonly ExternalEventReplyAdapter[] = [],
  ) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      const current = this.adapters.get(adapter.source) ?? [];
      current.push(adapter);
      this.adapters.set(adapter.source, current);
    }
  }

  async reply(input: InteractionActor & { content: string }): Promise<ProjectEventInteractionResult> {
    const context = await this.loadContext(input);
    const deferred = await this.findInteraction(input.inboxEventId, "defer");
    if (deferred?.status === "deferred") {
      throw new Error("This event was already deferred and cannot be replied to");
    }
    const existing = await this.findInteraction(input.inboxEventId, "reply");
    if (existing) {
      if (existing.content !== input.content) {
        throw new Error("This event already has a different reply; duplicate replies are not allowed");
      }
      if (existing.status === "sent") return result(existing);
      throw new Error(
        existing.status === "failed"
          ? `The previous reply attempt failed and was not retried automatically: ${existing.error_message ?? "unknown error"}`
          : "A reply to this event is already in progress",
      );
    }

    const adapter = (this.adapters.get(context.source) ?? [])
      .find((candidate) => candidate.supports(context));
    if (!adapter) {
      throw new Error(`No reply adapter supports ${context.source}:${context.eventType}`);
    }
    const pendingInsert = await this.insertInteraction(input, "reply", input.content, "pending");
    const pending = pendingInsert.row;
    if (!pendingInsert.inserted) {
      if (pending.content !== input.content) {
        throw new Error("This event already has a different reply; duplicate replies are not allowed");
      }
      if (pending.status === "sent") return result(pending);
      throw new Error(
        pending.status === "failed"
          ? `The previous reply attempt failed and was not retried automatically: ${pending.error_message ?? "unknown error"}`
          : "A reply to this event is already in progress",
      );
    }
    try {
      const provider = await adapter.reply(context, input.content);
      const updated = await this.pool.query<InteractionRow>(
        `UPDATE swarm_hive.event_interactions
            SET status = 'sent', provider_reply_id = $2, processed_at = now(),
                error_message = NULL
          WHERE id = $1
        RETURNING id, inbox_event_id, action, status, content,
                  provider_reply_id, error_message`,
        [pending.id, provider.providerReplyId ?? null],
      );
      return result(updated.rows[0] ?? pending);
    } catch (error) {
      const message = errorMessage(error);
      await this.pool.query(
        `UPDATE swarm_hive.event_interactions
            SET status = 'failed', error_message = $2, processed_at = now()
          WHERE id = $1`,
        [pending.id, message],
      );
      throw new Error(`Unable to reply to external event: ${message}`);
    }
  }

  async replyIfSupported(
    input: InteractionActor & { content: string },
  ): Promise<ProjectEventInteractionResult | null> {
    const context = await this.loadContext(input);
    const supported = (this.adapters.get(context.source) ?? [])
      .some((candidate) => candidate.supports(context));
    return supported ? this.reply(input) : null;
  }

  async defer(input: InteractionActor & { reason: string }): Promise<ProjectEventInteractionResult> {
    await this.loadContext(input);
    const replied = await this.findInteraction(input.inboxEventId, "reply");
    if (replied?.status === "sent") {
      throw new Error("This event was already replied to and cannot be deferred");
    }
    const existing = await this.findInteraction(input.inboxEventId, "defer");
    if (existing) {
      if (existing.content !== input.reason) {
        throw new Error("This event was already deferred with a different reason");
      }
      return result(existing);
    }
    const inserted = await this.insertInteraction(input, "defer", input.reason, "deferred");
    if (inserted.row.content !== input.reason) {
      throw new Error("This event was already deferred with a different reason");
    }
    return result(inserted.row);
  }

  async replay(input: {
    projectId: string;
    inboxEventIds: readonly string[];
    reason: string;
  }): Promise<{ replayedEventIds: string[] }> {
    if (input.inboxEventIds.length === 0) return { replayedEventIds: [] };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const events = await client.query<{ id: string }>(
        `SELECT id
           FROM swarm_hive.inbox_events
          WHERE project_id = $1
            AND id = ANY($2::uuid[])
          FOR UPDATE`,
        [input.projectId, input.inboxEventIds],
      );
      if (events.rowCount !== new Set(input.inboxEventIds).size) {
        throw new Error("One or more Inbox Events do not belong to the target project");
      }
      const sent = await client.query(
        `SELECT 1 FROM swarm_hive.event_interactions
          WHERE inbox_event_id = ANY($1::uuid[])
            AND action = 'reply' AND status = 'sent'
          LIMIT 1`,
        [input.inboxEventIds],
      );
      if (sent.rowCount) {
        throw new Error("A replied event cannot be replayed without an explicit force policy");
      }
      await client.query(
        `UPDATE swarm_hive.event_interactions
            SET status = 'superseded',
                error_message = $2,
                processed_at = coalesce(processed_at, now())
          WHERE inbox_event_id = ANY($1::uuid[])
            AND status <> 'superseded'`,
        [input.inboxEventIds, `Superseded by event replay: ${input.reason}`],
      );
      const deferredKeys = input.inboxEventIds.map((id) =>
        `external_event_${id.replaceAll("-", "")}`
      );
      await client.query(
        `UPDATE swarm_hive.project_deferred_items
            SET status = 'cancelled', completed_at = now(),
                evidence = evidence || jsonb_build_object(
                  'replayed_at', now(), 'replay_reason', $3::text
                )
          WHERE project_id = $1
            AND item_key = ANY($2::text[])
            AND status = 'open'`,
        [input.projectId, deferredKeys, input.reason],
      );
      const replayed = await client.query<{ id: string }>(
        `UPDATE swarm_hive.inbox_events
            SET status = 'pending', retry_count = 0,
                error_message = NULL, processing_started_at = NULL,
                processed_at = NULL
          WHERE project_id = $1 AND id = ANY($2::uuid[])
        RETURNING id`,
        [input.projectId, input.inboxEventIds],
      );
      await client.query("COMMIT");
      return { replayedEventIds: replayed.rows.map((row) => row.id) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadContext(input: InteractionActor): Promise<ProjectEventReplyContext> {
    const query = await this.pool.query<{
      id: string;
      project_id: string;
      source: string;
      event_type: string;
      payload: unknown;
    }>(
      `SELECT event.id, event.project_id, event.source, event.event_type, event.payload
         FROM swarm_hive.inbox_events event
         JOIN swarm_hive.agent_runs run
           ON run.id = $4
          AND run.project_id = event.project_id
         JOIN swarm_hive.agent_sessions session
           ON session.id = run.agent_session_id
          AND session.agent_seat_id = $3
        WHERE event.id = $1
          AND event.project_id = $2`,
      [input.inboxEventId, input.projectId, input.agentSeatId, input.runId],
    );
    const row = query.rows[0];
    if (!row) throw new Error("Inbox event is not available to this project Agent run");
    return {
      inboxEventId: row.id,
      projectId: row.project_id,
      source: row.source,
      eventType: row.event_type,
      payload: object(row.payload),
    };
  }

  private async findInteraction(
    inboxEventId: string,
    action: "reply" | "defer",
  ): Promise<InteractionRow | undefined> {
    const query = await this.pool.query<InteractionRow>(
      `SELECT id, inbox_event_id, action, status, content,
              provider_reply_id, error_message
         FROM swarm_hive.event_interactions
        WHERE inbox_event_id = $1 AND action = $2
          AND status <> 'superseded'
        ORDER BY created_at DESC LIMIT 1`,
      [inboxEventId, action],
    );
    return query.rows[0];
  }

  private async insertInteraction(
    input: InteractionActor,
    action: "reply" | "defer",
    content: string,
    status: "pending" | "deferred",
  ): Promise<{ row: InteractionRow; inserted: boolean }> {
    const query = await this.pool.query<InteractionRow>(
      `INSERT INTO swarm_hive.event_interactions(
         inbox_event_id, project_id, agent_seat_id, run_id,
         action, content, status, processed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7,
                 CASE WHEN $7 = 'deferred' THEN now() ELSE NULL END)
       ON CONFLICT (inbox_event_id, action) WHERE status <> 'superseded' DO NOTHING
       RETURNING id, inbox_event_id, action, status, content,
                 provider_reply_id, error_message`,
      [
        input.inboxEventId,
        input.projectId,
        input.agentSeatId,
        input.runId,
        action,
        content,
        status,
      ],
    );
    const row = query.rows[0];
    if (row) return { row, inserted: true };
    const concurrent = await this.findInteraction(input.inboxEventId, action);
    if (!concurrent) throw new Error("Event interaction was not recorded");
    return { row: concurrent, inserted: false };
  }
}
