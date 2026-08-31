CREATE TABLE swarm_hive.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_project_id text NOT NULL,
  external_url text,
  external_project_key text,
  external_work_item_type text,
  name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_project_id)
);

CREATE UNIQUE INDEX uq_projects_external_work_item_reference
  ON swarm_hive.projects(
    source, external_project_key, external_work_item_type, external_project_id
  )
  WHERE external_project_key IS NOT NULL AND external_work_item_type IS NOT NULL;

-- A durable realization of an Agent Spec. The default Instance is the current
-- singleton, while the composite key leaves room for named Instances later.
CREATE TABLE swarm_hive.agent_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_key text NOT NULL,
  spec_version integer NOT NULL CHECK (spec_version > 0),
  instance_key text NOT NULL DEFAULT 'default',
  home_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (spec_key, instance_key)
);

-- A project-scoped responsibility occupied by an Agent Instance. The same
-- Instance may occupy multiple Seats in one Project.
CREATE TABLE swarm_hive.agent_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES swarm_hive.projects(id) ON DELETE CASCADE,
  agent_instance_id uuid NOT NULL
    REFERENCES swarm_hive.agent_instances(id) ON DELETE RESTRICT,
  responsibility text NOT NULL CHECK (length(btrim(responsibility)) > 0),
  is_coordinator boolean NOT NULL DEFAULT false,
  workspace_key text NOT NULL UNIQUE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (released_at IS NULL OR released_at >= assigned_at)
);

CREATE UNIQUE INDEX uq_agent_seats_active_coordinator_project
  ON swarm_hive.agent_seats(project_id)
  WHERE released_at IS NULL AND is_coordinator;

CREATE INDEX ix_agent_seats_instance
  ON swarm_hive.agent_seats(agent_instance_id, created_at DESC);

-- A continuous conversation owned by a Seat. Runs activate a Session; they do
-- not own or replace its checkpoint thread.
CREATE TABLE swarm_hive.agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_seat_id uuid NOT NULL REFERENCES swarm_hive.agent_seats(id) ON DELETE CASCADE,
  thread_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'waiting', 'closed')),
  memory_snapshot text,
  memory_sha256 text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  CHECK ((memory_snapshot IS NULL) = (memory_sha256 IS NULL))
);

CREATE UNIQUE INDEX uq_agent_sessions_open_seat
  ON swarm_hive.agent_sessions(agent_seat_id)
  WHERE status IN ('active', 'waiting');

CREATE TABLE swarm_hive.external_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_event_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_event_id)
);

CREATE INDEX ix_external_events_resource
  ON swarm_hive.external_events(source, resource_type, resource_id, event_type, received_at DESC);

CREATE TABLE swarm_hive.inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_event_id text NOT NULL,
  external_event_record_id uuid REFERENCES swarm_hive.external_events(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES swarm_hive.projects(id) ON DELETE SET NULL,
  target_agent_seat_id uuid REFERENCES swarm_hive.agent_seats(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  subscription_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'ignored')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source, external_event_id)
);

CREATE INDEX ix_inbox_events_pending
  ON swarm_hive.inbox_events(received_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX ix_inbox_events_project
  ON swarm_hive.inbox_events(project_id, received_at DESC);

CREATE INDEX ix_inbox_events_target_agent_seat
  ON swarm_hive.inbox_events(target_agent_seat_id, received_at)
  WHERE target_agent_seat_id IS NOT NULL AND status IN ('pending', 'failed');

CREATE TABLE swarm_hive.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Immutable routing snapshots keep operational queries cheap while the
  -- authoritative ownership chain remains Session -> Seat -> Instance/Project.
  project_id uuid NOT NULL REFERENCES swarm_hive.projects(id) ON DELETE RESTRICT,
  agent_instance_id uuid NOT NULL REFERENCES swarm_hive.agent_instances(id) ON DELETE RESTRICT,
  agent_session_id uuid NOT NULL
    REFERENCES swarm_hive.agent_sessions(id) ON DELETE RESTRICT,
  trigger_event_id uuid REFERENCES swarm_hive.inbox_events(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'running', 'waiting_user', 'succeeded', 'failed', 'cancelled'
    )),
  task_summary text,
  result_summary text,
  merge_request_url text,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE UNIQUE INDEX uq_agent_runs_trigger_event
  ON swarm_hive.agent_runs(trigger_event_id)
  WHERE trigger_event_id IS NOT NULL;

CREATE UNIQUE INDEX uq_agent_runs_active_session
  ON swarm_hive.agent_runs(agent_session_id)
  WHERE status IN ('queued', 'running', 'waiting_user');

CREATE INDEX ix_agent_runs_session_created
  ON swarm_hive.agent_runs(agent_session_id, created_at DESC);

CREATE INDEX ix_agent_runs_project_created
  ON swarm_hive.agent_runs(project_id, created_at DESC);

CREATE INDEX ix_agent_runs_instance_created
  ON swarm_hive.agent_runs(agent_instance_id, created_at DESC);

CREATE TABLE swarm_hive.agent_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id uuid NOT NULL REFERENCES swarm_hive.agent_runs(id) ON DELETE CASCADE,
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  event_type text NOT NULL,
  level text NOT NULL DEFAULT 'info'
    CHECK (level IN ('debug', 'info', 'warning', 'error')),
  title text NOT NULL,
  detail text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  visible_to_user boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_run_id, sequence_no)
);

CREATE INDEX ix_agent_run_events_timeline
  ON swarm_hive.agent_run_events(agent_run_id, sequence_no);

CREATE TABLE swarm_hive.project_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES swarm_hive.projects(id) ON DELETE CASCADE,
  parent_task_id uuid REFERENCES swarm_hive.project_tasks(id) ON DELETE SET NULL,
  created_by_agent_seat_id uuid NOT NULL
    REFERENCES swarm_hive.agent_seats(id) ON DELETE RESTRICT,
  assignee_agent_seat_id uuid REFERENCES swarm_hive.agent_seats(id) ON DELETE SET NULL,
  created_by_run_id uuid REFERENCES swarm_hive.agent_runs(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text NOT NULL DEFAULT '',
  acceptance_criteria text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled'
    )),
  blocked_reason text,
  result text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL),
  CHECK (completed_at IS NULL OR status IN ('completed', 'cancelled'))
);

CREATE INDEX ix_project_tasks_project_status
  ON swarm_hive.project_tasks(project_id, status, created_at);

CREATE INDEX ix_project_tasks_assignee
  ON swarm_hive.project_tasks(assignee_agent_seat_id, status, updated_at DESC)
  WHERE assignee_agent_seat_id IS NOT NULL;

ALTER TABLE swarm_hive.agent_runs
  ADD COLUMN task_id uuid REFERENCES swarm_hive.project_tasks(id) ON DELETE SET NULL;

CREATE INDEX ix_agent_runs_task
  ON swarm_hive.agent_runs(task_id, created_at DESC)
  WHERE task_id IS NOT NULL;

CREATE TABLE swarm_hive.project_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES swarm_hive.projects(id) ON DELETE CASCADE,
  agent_seat_id uuid NOT NULL REFERENCES swarm_hive.agent_seats(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES swarm_hive.agent_runs(id) ON DELETE SET NULL,
  confirmation_key text NOT NULL,
  phase text NOT NULL,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocking_scope text NOT NULL DEFAULT 'current_phase'
    CHECK (blocking_scope IN ('current_phase', 'future_phase', 'non_blocking', 'final_only')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answer_received', 'resolved', 'cancelled')),
  artifact_url text,
  artifact_revision integer,
  answer text,
  answer_source text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (project_id, confirmation_key)
);

CREATE INDEX ix_project_confirmations_open
  ON swarm_hive.project_confirmations(project_id, created_at)
  WHERE status IN ('open', 'answer_received');

CREATE INDEX ix_project_confirmations_artifact_watch
  ON swarm_hive.project_confirmations(artifact_url)
  WHERE artifact_url IS NOT NULL AND status <> 'cancelled';

CREATE TABLE swarm_hive.project_deferred_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES swarm_hive.projects(id) ON DELETE CASCADE,
  agent_seat_id uuid NOT NULL REFERENCES swarm_hive.agent_seats(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES swarm_hive.agent_runs(id) ON DELETE SET NULL,
  item_key text NOT NULL,
  phase text NOT NULL,
  title text NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'cancelled')),
  report_policy text NOT NULL DEFAULT 'phase_end'
    CHECK (report_policy IN ('phase_end', 'final_only')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (project_id, item_key)
);

CREATE INDEX ix_project_deferred_items_open
  ON swarm_hive.project_deferred_items(project_id, created_at)
  WHERE status = 'open';

CREATE TABLE swarm_hive.project_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES swarm_hive.projects(id) ON DELETE CASCADE,
  agent_seat_id uuid NOT NULL REFERENCES swarm_hive.agent_seats(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES swarm_hive.agent_runs(id) ON DELETE SET NULL,
  task_id uuid REFERENCES swarm_hive.project_tasks(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('questions', 'progress', 'phase_result', 'final')),
  summary text NOT NULL CHECK (length(btrim(summary)) > 0),
  relative_path text NOT NULL,
  sha256 text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, relative_path, sha256),
  UNIQUE (project_id, kind, version)
);

CREATE INDEX ix_project_publications_latest
  ON swarm_hive.project_publications(project_id, kind, version DESC);

CREATE TABLE swarm_hive.project_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES swarm_hive.projects(id) ON DELETE CASCADE,
  subscription_key text NOT NULL,
  source text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  event_type text NOT NULL,
  inbox_event_type text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, subscription_key, event_type)
);

CREATE INDEX ix_project_subscriptions_match
  ON swarm_hive.project_subscriptions(source, resource_type, resource_id, event_type)
  WHERE status = 'active';

CREATE INDEX ix_project_subscriptions_project
  ON swarm_hive.project_subscriptions(project_id, updated_at DESC);

CREATE TABLE swarm_hive.event_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_event_id uuid NOT NULL REFERENCES swarm_hive.inbox_events(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES swarm_hive.projects(id) ON DELETE CASCADE,
  agent_seat_id uuid NOT NULL REFERENCES swarm_hive.agent_seats(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES swarm_hive.agent_runs(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('reply', 'defer')),
  content text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'deferred', 'failed', 'superseded')),
  provider_reply_id text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_event_interactions_active_action
  ON swarm_hive.event_interactions(inbox_event_id, action)
  WHERE status <> 'superseded';

CREATE INDEX ix_event_interactions_project
  ON swarm_hive.event_interactions(project_id, created_at DESC);

CREATE INDEX ix_event_interactions_run
  ON swarm_hive.event_interactions(run_id, created_at DESC);

CREATE TABLE swarm_hive.agent_run_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_seat_id uuid NOT NULL REFERENCES swarm_hive.agent_seats(id) ON DELETE CASCADE,
  source_run_id uuid NOT NULL UNIQUE REFERENCES swarm_hive.agent_runs(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_agent_run_handoffs_previous
  ON swarm_hive.agent_run_handoffs(agent_seat_id, created_at DESC);

CREATE OR REPLACE FUNCTION swarm_hive.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'projects', 'agent_instances', 'agent_seats', 'agent_sessions',
    'external_events', 'inbox_events', 'agent_runs', 'project_tasks',
    'project_confirmations', 'project_deferred_items', 'project_subscriptions',
    'event_interactions', 'agent_run_handoffs'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON swarm_hive.%I '
      'FOR EACH ROW EXECUTE FUNCTION swarm_hive.set_updated_at()',
      table_name, table_name
    );
  END LOOP;
END;
$$;
