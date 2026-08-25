CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE ai_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'ai' CHECK (status IN ('ai', 'handoff_requested', 'human', 'closed')),
  control_version bigint NOT NULL DEFAULT 1 CHECK (control_version > 0),
  takeover_epoch bigint NOT NULL DEFAULT 0 CHECK (takeover_epoch >= 0),
  next_event_sequence bigint NOT NULL DEFAULT 1 CHECK (next_event_sequence > 0),
  active_run_id uuid,
  assigned_user_id text,
  locale text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz
);

CREATE TABLE conversation_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX conversation_credentials_scope_idx
  ON conversation_credentials (conversation_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  operation_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'running', 'completed', 'failed', 'cancelled')),
  control_version bigint NOT NULL CHECK (control_version > 0),
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
  engine_id text NOT NULL,
  engine_version text NOT NULL,
  image_digest text,
  engine_run_id text,
  cancel_requested_at timestamptz,
  last_append_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, id),
  UNIQUE (id, operation_id)
);
CREATE UNIQUE INDEX ai_runs_one_live_per_conversation_idx
  ON ai_runs (conversation_id)
  WHERE status IN ('creating', 'running');
ALTER TABLE conversations
  ADD CONSTRAINT conversations_active_run_fk
  FOREIGN KEY (id, active_run_id) REFERENCES ai_runs(conversation_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE engine_run_handles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  engine_run_id text NOT NULL,
  operation_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_id),
  UNIQUE (engine_run_id),
  FOREIGN KEY (conversation_id, run_id) REFERENCES ai_runs(conversation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, operation_id) REFERENCES ai_runs(id, operation_id) ON DELETE RESTRICT
);

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('visitor', 'assistant', 'human')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  idempotency_key text NOT NULL,
  accepted_in_epoch bigint NOT NULL CHECK (accepted_in_epoch >= 0),
  answered_by_run uuid,
  event_sequence bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, idempotency_key),
  UNIQUE (conversation_id, id),
  FOREIGN KEY (conversation_id, answered_by_run) REFERENCES ai_runs(conversation_id, id) ON DELETE RESTRICT
);
CREATE INDEX conversation_messages_unanswered_idx
  ON conversation_messages (conversation_id, accepted_in_epoch, created_at)
  WHERE answered_by_run IS NULL AND role = 'visitor';

CREATE TABLE conversation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id uuid,
  sequence bigint NOT NULL CHECK (sequence > 0),
  type text NOT NULL CHECK (type IN (
    'token', 'citation', 'final', 'error', 'handoff.started',
    'assistant.cancelled', 'run.failed', 'conversation.closed'
  )),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, sequence),
  FOREIGN KEY (conversation_id, run_id) REFERENCES ai_runs(conversation_id, id) ON DELETE RESTRICT,
  CHECK (
    (type = 'token' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'text') = 'string') OR
    (type = 'citation' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'sourceId') = 'string' AND jsonb_typeof(payload -> 'title') = 'string') OR
    (type = 'final' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'text') = 'string') OR
    (type = 'error' AND run_id IS NOT NULL AND jsonb_typeof(payload -> 'category') = 'string') OR
    (type IN ('handoff.started', 'assistant.cancelled', 'run.failed', 'conversation.closed')
      AND NOT (payload ?| ARRAY['text', 'content', 'message', 'vendor', 'prompt', 'stack']))
  )
);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE RESTRICT,
  email text,
  phone text,
  name text,
  consent_text_version text NOT NULL,
  consented_at timestamptz NOT NULL,
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id uuid,
  type text NOT NULL CHECK (type IN ('start_run', 'cancel_run', 'sales_notification', 'email', 'crm')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_until timestamptz,
  last_error_category text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, run_id) REFERENCES ai_runs(conversation_id, id) ON DELETE RESTRICT
);
CREATE INDEX outbox_pending_idx ON outbox (available_at, created_at) WHERE status = 'pending';
CREATE INDEX outbox_reclaim_idx ON outbox (claimed_until) WHERE status = 'processing';

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('visitor', 'sales', 'system')),
  actor_ref text,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE ai_rate_limit_buckets (
  bucket_key text NOT NULL,
  window_started_at timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits >= 0),
  PRIMARY KEY (bucket_key, window_started_at)
);

INSERT INTO ai_schema_migrations(version) VALUES ('001_ai_assistant');
