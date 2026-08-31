ALTER TABLE swarm_hive.agent_seats
  DROP CONSTRAINT IF EXISTS agent_seats_responsibility_check;

ALTER TABLE swarm_hive.agent_seats
  ALTER COLUMN responsibility SET DEFAULT '';
