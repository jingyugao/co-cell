ALTER TABLE agent_staff.project_agent_instances
  DROP COLUMN IF EXISTS repository_url,
  DROP COLUMN IF EXISTS base_branch;
