BEGIN;

-- The structured requirement summary for one conversation (assistant-ui MIU 19).
ALTER TABLE conversations ADD COLUMN need_state jsonb;
-- Model usage for one visitor question, summed over its calls and attempts.
ALTER TABLE ai_runs ADD COLUMN usage jsonb;
INSERT INTO ai_schema_migrations(version) VALUES ('006_need_state_usage');

COMMIT;
