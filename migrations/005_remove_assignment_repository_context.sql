ALTER TABLE swarm_hive.project_agent_instances
  DROP COLUMN IF EXISTS repository_url,
  DROP COLUMN IF EXISTS base_branch;
