CREATE UNIQUE INDEX uq_agent_instance_runs_trigger_event
  ON agent_staff.agent_instance_runs(trigger_event_id)
  WHERE trigger_event_id IS NOT NULL;

CREATE UNIQUE INDEX uq_agent_instance_runs_active_instance
  ON agent_staff.agent_instance_runs(agent_instance_id)
  WHERE status IN ('queued', 'running', 'waiting_user');
