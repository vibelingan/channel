BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM conversation_events WHERE type='tool.progress') THEN
  RAISE EXCEPTION 'Cannot remove progress support while recorded progress events exist';
 END IF;
END $$;
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_type_check;
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_type_check CHECK (type IN ('token', 'citation', 'final', 'error', 'handoff.started', 'assistant.cancelled', 'run.failed', 'conversation.closed'));
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_check CHECK ((type = 'token' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'text') = 'string') OR
(type = 'citation' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'sourceId') = 'string' AND jsonb_typeof(payload -> 'title') = 'string') OR
(type = 'final' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'text') = 'string') OR
(type = 'error' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'category') = 'string') OR
(type IN ('handoff.started', 'assistant.cancelled', 'run.failed', 'conversation.closed')
 AND NOT (payload ?| ARRAY['text','content','message','vendor','prompt','stack'])));
DELETE FROM ai_schema_migrations WHERE version='005_tool_progress';
COMMIT;
