-- Run explicitly with psql -v team_id=<uuid> -v max_hours=<hours>.
-- Changes only this team's lifetime override. Existing running sandboxes keep
-- their original limit until paused and resumed. Auth cache refresh: up to 5 min.
\set ON_ERROR_STOP on

BEGIN;

SELECT :'max_hours'::bigint BETWEEN 1 AND 8760 AS valid_hours \gset
\if :valid_hours
\else
  \echo 'max_hours must be between 1 and 8760.'
  \quit 1
\endif

-- Serialize changes for the selected team and fail if it does not exist.
SELECT id FROM public.teams WHERE id = :'team_id'::uuid FOR UPDATE;
SELECT EXISTS (SELECT 1 FROM public.team_limits WHERE id = :'team_id'::uuid) AS team_exists \gset
\if :team_exists
\else
  \echo 'Team not found or effective limits unavailable; no changes applied.'
  \quit 1
\endif

-- A first override must provide all limits: copy the current effective values.
-- Later runs change only max_length_hours, preserving other override fields.
INSERT INTO public.project_limits (
  team_id, max_length_hours, concurrent_sandboxes, concurrent_template_builds,
  max_vcpu, max_ram_mb, disk_mb, events_ttl_days,
  default_free_disk_size_mb, max_disk_size_mb
)
SELECT id, :'max_hours'::bigint, concurrent_sandboxes, concurrent_template_builds,
  max_vcpu, max_ram_mb, disk_mb, events_ttl_days,
  default_free_disk_size_mb, max_disk_size_mb
FROM public.team_limits
WHERE id = :'team_id'::uuid
ON CONFLICT (team_id) DO UPDATE
SET max_length_hours = EXCLUDED.max_length_hours, updated_at = now();

SELECT id AS team_id, max_length_hours
FROM public.team_limits WHERE id = :'team_id'::uuid;

COMMIT;
