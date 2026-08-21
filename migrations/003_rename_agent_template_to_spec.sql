ALTER TABLE agent_staff.agent_instances
  RENAME COLUMN template_key TO spec_key;

ALTER TABLE agent_staff.agent_instances
  RENAME COLUMN template_version TO spec_version;
