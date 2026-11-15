BEGIN;
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_type_check;
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_type_check CHECK (type IN ('token', 'citation', 'final', 'error', 'handoff.started', 'assistant.cancelled', 'run.failed', 'conversation.closed', 'tool.progress'));
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_check CHECK (
(type = 'token' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'text') = 'string') OR
(type = 'citation' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'sourceId') = 'string' AND jsonb_typeof(payload -> 'title') = 'string') OR
(type = 'final' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'text') = 'string') OR
(type = 'error' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'category') = 'string') OR
(type IN ('handoff.started', 'assistant.cancelled', 'run.failed', 'conversation.closed')
 AND NOT (payload ?| ARRAY['text','content','message','vendor','prompt','stack'])) OR (type = 'tool.progress' AND run_id IS NOT NULL AND
  jsonb_typeof(payload) = 'object' AND payload ? 'action' AND jsonb_typeof(payload->'action') = 'string' AND
  payload->>'action' IN ('knowledge_search','model_answer','product_search') AND
  payload - 'action' = '{}'::jsonb));
INSERT INTO ai_schema_migrations(version) VALUES ('005_tool_progress');
COMMIT;
