ALTER TABLE swarm_hive.agent_instances
  RENAME COLUMN template_key TO spec_key;

ALTER TABLE swarm_hive.agent_instances
  RENAME COLUMN template_version TO spec_version;
