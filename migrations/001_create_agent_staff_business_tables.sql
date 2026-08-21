CREATE TABLE agent_staff.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_project_id text NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_project_id)
);

CREATE TABLE agent_staff.agent_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL,
  template_version integer NOT NULL CHECK (template_version > 0),
  thread_id text NOT NULL UNIQUE,
  workspace_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'queued', 'running', 'waiting', 'disabled', 'failed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_staff.project_agent_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES agent_staff.projects(id) ON DELETE CASCADE,
  agent_instance_id uuid NOT NULL
    REFERENCES agent_staff.agent_instances(id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'primary',
  is_primary boolean NOT NULL DEFAULT true,
  bound_at timestamptz NOT NULL DEFAULT now(),
  unbound_at timestamptz,
  CHECK (unbound_at IS NULL OR unbound_at >= bound_at)
);

CREATE UNIQUE INDEX uq_project_agent_instances_active_primary_project
  ON agent_staff.project_agent_instances(project_id)
  WHERE unbound_at IS NULL AND is_primary;

CREATE UNIQUE INDEX uq_project_agent_instances_active_instance
  ON agent_staff.project_agent_instances(agent_instance_id)
  WHERE unbound_at IS NULL;

CREATE INDEX ix_project_agent_instances_project_history
  ON agent_staff.project_agent_instances(project_id, bound_at DESC);

CREATE TABLE agent_staff.inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_event_id text NOT NULL,
  project_id uuid REFERENCES agent_staff.projects(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'ignored')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_event_id)
);

CREATE INDEX ix_inbox_events_pending
  ON agent_staff.inbox_events(received_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX ix_inbox_events_project
  ON agent_staff.inbox_events(project_id, received_at DESC);

CREATE TABLE agent_staff.agent_instance_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES agent_staff.projects(id) ON DELETE RESTRICT,
  agent_instance_id uuid NOT NULL
    REFERENCES agent_staff.agent_instances(id) ON DELETE RESTRICT,
  trigger_event_id uuid REFERENCES agent_staff.inbox_events(id) ON DELETE SET NULL,
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

CREATE INDEX ix_agent_instance_runs_project_created
  ON agent_staff.agent_instance_runs(project_id, created_at DESC);

CREATE INDEX ix_agent_instance_runs_instance_created
  ON agent_staff.agent_instance_runs(agent_instance_id, created_at DESC);

CREATE INDEX ix_agent_instance_runs_active
  ON agent_staff.agent_instance_runs(created_at)
  WHERE status IN ('queued', 'running', 'waiting_user');

CREATE TABLE agent_staff.agent_instance_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_instance_run_id uuid NOT NULL
    REFERENCES agent_staff.agent_instance_runs(id) ON DELETE CASCADE,
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  event_type text NOT NULL,
  level text NOT NULL DEFAULT 'info'
    CHECK (level IN ('debug', 'info', 'warning', 'error')),
  title text NOT NULL,
  detail text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  visible_to_user boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_instance_run_id, sequence_no)
);

CREATE INDEX ix_agent_instance_run_events_timeline
  ON agent_staff.agent_instance_run_events(agent_instance_run_id, sequence_no);

CREATE OR REPLACE FUNCTION agent_staff.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_set_updated_at
BEFORE UPDATE ON agent_staff.projects
FOR EACH ROW EXECUTE FUNCTION agent_staff.set_updated_at();

CREATE TRIGGER agent_instances_set_updated_at
BEFORE UPDATE ON agent_staff.agent_instances
FOR EACH ROW EXECUTE FUNCTION agent_staff.set_updated_at();

CREATE TRIGGER inbox_events_set_updated_at
BEFORE UPDATE ON agent_staff.inbox_events
FOR EACH ROW EXECUTE FUNCTION agent_staff.set_updated_at();

CREATE TRIGGER agent_instance_runs_set_updated_at
BEFORE UPDATE ON agent_staff.agent_instance_runs
FOR EACH ROW EXECUTE FUNCTION agent_staff.set_updated_at();
