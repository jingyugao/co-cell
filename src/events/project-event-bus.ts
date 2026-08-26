import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { ExternalAgentEvent } from "../contracts/workflow.js";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export interface ProjectSubscriptionInput {
  projectId: string;
  subscriptionKey: string;
  source: string;
  resourceType: string;
  resourceId: string;
  eventType: string;
  inboxEventType: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalEventInput {
  source: string;
  externalEventId: string;
  resourceType: string;
  resourceId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ProjectEventPublishResult {
  externalEventId: string;
  matchedSubscriptionCount: number;
  deliveredProjectIds: string[];
  duplicateProjectIds: string[];
}

export interface ProjectEventDispatchTarget {
  projectId: string;
  runId: string;
  agentInstanceId: string;
}

export interface ProjectEventRunNotifier {
  notify(runId: string): void;
}

export function feishuDocumentResource(documentUrl: string): {
  resourceId: string;
  fileType: string;
  fileToken: string;
} | undefined {
  try {
    const parts = new URL(documentUrl).pathname.split("/").filter(Boolean);
    const typeIndex = parts.findIndex((part) =>
      ["doc", "docx", "sheet", "slides", "base", "bitable", "file"].includes(part)
    );
    const fileType = parts[typeIndex] === "base" ? "bitable" : parts[typeIndex];
    const fileToken = typeIndex >= 0 ? parts[typeIndex + 1] : undefined;
    return fileType && fileToken
      ? { resourceId: `${fileType}:${fileToken}`, fileType, fileToken }
      : undefined;
  } catch {
    return undefined;
  }
}

export class PostgresProjectEventBus {
  constructor(private readonly pool: Pool) {}

  async upsertSubscription(input: ProjectSubscriptionInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO swarm_hive.project_subscriptions(
         project_id, subscription_key, source, resource_type, resource_id,
         event_type, inbox_event_type, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (project_id, subscription_key, event_type) DO UPDATE SET
         source = excluded.source,
         resource_type = excluded.resource_type,
         resource_id = excluded.resource_id,
         inbox_event_type = excluded.inbox_event_type,
         status = 'active',
         metadata = excluded.metadata`,
      [
        input.projectId,
        input.subscriptionKey,
        input.source,
        input.resourceType,
        input.resourceId,
        input.eventType,
        input.inboxEventType,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async deactivateSubscription(input: {
    projectId: string;
    subscriptionKey: string;
    eventType?: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE swarm_hive.project_subscriptions
          SET status = 'inactive'
        WHERE project_id = $1
          AND subscription_key = $2
          AND ($3::text IS NULL OR event_type = $3)`,
      [input.projectId, input.subscriptionKey, input.eventType ?? null],
    );
  }

  async matchingSubscriptionCount(input: Pick<ExternalEventInput,
    "source" | "resourceType" | "resourceId" | "eventType">): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM swarm_hive.project_subscriptions
        WHERE status = 'active'
          AND source = $1
          AND resource_type = $2
          AND resource_id = $3
          AND event_type = $4`,
      [input.source, input.resourceType, input.resourceId, input.eventType],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async recordExternalEvent(input: ExternalEventInput): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO swarm_hive.external_events(
         source, external_event_id, resource_type, resource_id, event_type, payload
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (source, external_event_id) DO UPDATE SET
         resource_type = excluded.resource_type,
         resource_id = excluded.resource_id,
         event_type = excluded.event_type,
         payload = swarm_hive.external_events.payload || excluded.payload
       RETURNING id`,
      [
        input.source,
        input.externalEventId,
        input.resourceType,
        input.resourceId,
        input.eventType,
        JSON.stringify(input.payload),
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("External event was not recorded");
    return id;
  }

  async publishExternalEvent(input: ExternalEventInput): Promise<ProjectEventPublishResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const externalEventRecordId = await this.recordExternalEventWithClient(client, input);
      const subscriptions = await client.query<{
        id: string;
        project_id: string;
        inbox_event_type: string;
        metadata: unknown;
      }>(
        `SELECT id, project_id, inbox_event_type, metadata
           FROM swarm_hive.project_subscriptions
          WHERE status = 'active'
            AND source = $1
            AND resource_type = $2
            AND resource_id = $3
            AND event_type = $4
          ORDER BY project_id, created_at, id`,
        [input.source, input.resourceType, input.resourceId, input.eventType],
      );
      const byProject = new Map<string, typeof subscriptions.rows>();
      for (const subscription of subscriptions.rows) {
        const current = byProject.get(subscription.project_id) ?? [];
        current.push(subscription);
        byProject.set(subscription.project_id, current);
      }
      const deliveredProjectIds: string[] = [];
      const duplicateProjectIds: string[] = [];
      for (const [projectId, matches] of byProject) {
        const inboxEventTypes = [...new Set(matches.map((item) => item.inbox_event_type))];
        const inboxEventType = inboxEventTypes.length === 1
          ? inboxEventTypes[0]!
          : "external_resource_event_received";
        const result = await client.query(
          `INSERT INTO swarm_hive.inbox_events(
             source, external_event_id, external_event_record_id, subscription_ids,
             project_id, event_type, payload
           ) VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7::jsonb)
           ON CONFLICT (project_id, source, external_event_id) DO NOTHING`,
          [
            input.source,
            input.externalEventId,
            externalEventRecordId,
            matches.map((item) => item.id),
            projectId,
            inboxEventType,
            JSON.stringify({
              ...input.payload,
              subscriptions: matches.map((item) => ({
                id: item.id,
                metadata: object(item.metadata),
              })),
            }),
          ],
        );
        (result.rowCount === 1 ? deliveredProjectIds : duplicateProjectIds).push(projectId);
      }
      await client.query("COMMIT");
      return {
        externalEventId: input.externalEventId,
        matchedSubscriptionCount: subscriptions.rowCount ?? 0,
        deliveredProjectIds,
        duplicateProjectIds,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async publishProjectEvent(input: {
    projectId: string;
    source: string;
    externalEventId?: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    const externalEventId = input.externalEventId ?? `${input.eventType}-${randomUUID()}`;
    const externalEventRecordId = await this.recordExternalEvent({
      source: input.source,
      externalEventId,
      resourceType: "project",
      resourceId: input.projectId,
      eventType: input.eventType,
      payload: input.payload,
    });
    const result = await this.pool.query(
      `INSERT INTO swarm_hive.inbox_events(
         source, external_event_id, external_event_record_id,
         project_id, event_type, payload
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (project_id, source, external_event_id) DO NOTHING`,
      [
        input.source,
        externalEventId,
        externalEventRecordId,
        input.projectId,
        input.eventType,
        JSON.stringify(input.payload),
      ],
    );
    return result.rowCount === 1;
  }

  async claimPendingEvents(runId: string, limit = 20): Promise<ExternalAgentEvent[]> {
    await this.recoverStaleProcessingEvents();
    const result = await this.pool.query<{
      id: string;
      source: string;
      external_event_id: string;
      event_type: string;
      payload: unknown;
      received_at: Date;
    }>(
      `WITH candidates AS (
         SELECT event.id
           FROM swarm_hive.inbox_events event
           JOIN swarm_hive.agent_runs run ON run.project_id = event.project_id
          WHERE run.id = $1
            AND (event.status = 'pending' OR (event.status = 'failed' AND event.retry_count < 3))
          ORDER BY event.received_at, event.id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE swarm_hive.inbox_events event
          SET status = 'processing', processing_started_at = now()
         FROM candidates
        WHERE event.id = candidates.id
       RETURNING event.id, event.source, event.external_event_id, event.event_type,
                 event.payload, event.received_at`,
      [runId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      source: row.source,
      externalEventId: row.external_event_id,
      eventType: row.event_type,
      payload: object(row.payload),
      receivedAt: iso(row.received_at),
    }));
  }

  async completeEvents(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.pool.query(
      `UPDATE swarm_hive.inbox_events
          SET status = 'completed', processed_at = now(), processing_started_at = NULL,
              error_message = NULL
        WHERE id = ANY($1::uuid[])`,
      [eventIds],
    );
  }

  async failEvents(eventIds: string[], error: string): Promise<void> {
    if (eventIds.length === 0) return;
    await this.pool.query(
      `UPDATE swarm_hive.inbox_events
          SET status = 'failed', retry_count = retry_count + 1,
              processing_started_at = NULL, error_message = $2
        WHERE id = ANY($1::uuid[])`,
      [eventIds, error],
    );
  }

  async recoverStaleProcessingEvents(maxAgeMinutes = 15): Promise<number> {
    const result = await this.pool.query(
      `UPDATE swarm_hive.inbox_events
          SET status = 'pending', processing_started_at = NULL,
              error_message = 'Recovered after processing lease expired'
        WHERE status = 'processing'
          AND processing_started_at < now() - make_interval(mins => $1)`,
      [maxAgeMinutes],
    );
    return result.rowCount ?? 0;
  }

  async pendingProjectIds(limit = 1_000): Promise<string[]> {
    const result = await this.pool.query<{ project_id: string }>(
      `SELECT project_id
         FROM swarm_hive.inbox_events
        WHERE project_id IS NOT NULL
          AND (status = 'pending' OR (status = 'failed' AND retry_count < 3))
        GROUP BY project_id
        ORDER BY min(received_at)
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.project_id);
  }

  async findDispatchTarget(projectId: string): Promise<ProjectEventDispatchTarget | null> {
    const result = await this.pool.query<{
      project_id: string;
      run_id: string;
      agent_instance_id: string;
    }>(
      `SELECT run.project_id, run.id AS run_id, run.agent_instance_id
         FROM swarm_hive.agent_runs run
         JOIN swarm_hive.agent_instances instance
           ON instance.id = run.agent_instance_id
          AND instance.status = 'active'
        WHERE run.project_id = $1
          AND run.status IN ('running', 'waiting_user', 'failed')
        ORDER BY CASE run.status
                   WHEN 'running' THEN 0
                   WHEN 'waiting_user' THEN 1
                   ELSE 2
                 END,
                 run.created_at DESC
        LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    return row
      ? { projectId: row.project_id, runId: row.run_id, agentInstanceId: row.agent_instance_id }
      : null;
  }

  private async recordExternalEventWithClient(
    client: PoolClient,
    input: ExternalEventInput,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO swarm_hive.external_events(
         source, external_event_id, resource_type, resource_id, event_type, payload
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (source, external_event_id) DO UPDATE SET
         resource_type = excluded.resource_type,
         resource_id = excluded.resource_id,
         event_type = excluded.event_type,
         payload = swarm_hive.external_events.payload || excluded.payload
       RETURNING id`,
      [
        input.source,
        input.externalEventId,
        input.resourceType,
        input.resourceId,
        input.eventType,
        JSON.stringify(input.payload),
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("External event was not recorded");
    return id;
  }
}

export class SingleAgentProjectEventDispatcher {
  constructor(
    private readonly eventBus: Pick<PostgresProjectEventBus, "findDispatchTarget">,
    private readonly notifier: ProjectEventRunNotifier,
  ) {}

  async dispatch(projectIds: readonly string[]): Promise<void> {
    for (const projectId of new Set(projectIds)) {
      const target = await this.eventBus.findDispatchTarget(projectId);
      if (target) this.notifier.notify(target.runId);
    }
  }
}
