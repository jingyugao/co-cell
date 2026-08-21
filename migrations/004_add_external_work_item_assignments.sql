ALTER TABLE agent_staff.projects
  ADD COLUMN external_url text,
  ADD COLUMN external_project_key text,
  ADD COLUMN external_work_item_type text;

CREATE UNIQUE INDEX uq_projects_external_work_item_reference
  ON agent_staff.projects(
    source, external_project_key, external_work_item_type, external_project_id
  )
  WHERE external_project_key IS NOT NULL AND external_work_item_type IS NOT NULL;
