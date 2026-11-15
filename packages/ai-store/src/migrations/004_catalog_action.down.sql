BEGIN;

ALTER TABLE conversation_messages DROP COLUMN IF EXISTS catalog_action;
DELETE FROM ai_schema_migrations WHERE version='004_catalog_action';

COMMIT;
