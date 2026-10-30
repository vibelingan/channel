BEGIN;

ALTER TABLE conversation_messages ADD COLUMN catalog_action jsonb;
INSERT INTO ai_schema_migrations(version) VALUES ('004_catalog_action');

COMMIT;
