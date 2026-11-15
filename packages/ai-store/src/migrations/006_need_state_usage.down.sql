BEGIN;

ALTER TABLE ai_runs DROP COLUMN IF EXISTS usage;
ALTER TABLE conversations DROP COLUMN IF EXISTS need_state;
DELETE FROM ai_schema_migrations WHERE version='006_need_state_usage';

COMMIT;
