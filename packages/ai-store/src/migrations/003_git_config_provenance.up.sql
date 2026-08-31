BEGIN;

-- A Git commit identifies source, not the systemd/nginx/env/provider
-- configuration that turns that source into the service which answered. The
-- hosted KB runs from a CVM checkout, so Git provenance is acceptable only
-- when it also names a canonical configuration digest.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_provenance_shape;

-- Rows written after migration 002 but before this migration may carry the
-- then-valid two-field Git shape. There is no truthful config digest to
-- backfill. Preserve the old assertion as audit evidence and clear it from the
-- canonical columns before tightening the constraint; inventing a digest would
-- make the migration green by corrupting the exact fact it exists to protect.
INSERT INTO audit_events(conversation_id, actor_type, action, metadata)
SELECT conversation_id,
       'system',
       'engine_provenance_git_config_missing',
       jsonb_build_object('runId', id, 'legacyGitProvenance', engine_provenance)
FROM ai_runs
WHERE engine_provenance_kind = 'git'
  AND (
    NOT (engine_provenance ? 'configDigest')
    OR COALESCE(engine_provenance->>'configDigest', '') !~ '^sha256:[0-9a-f]{64}$'
  );

UPDATE ai_runs
SET engine_provenance_kind = NULL,
    engine_provenance = NULL
WHERE engine_provenance_kind = 'git'
  AND (
    NOT (engine_provenance ? 'configDigest')
    OR COALESCE(engine_provenance->>'configDigest', '') !~ '^sha256:[0-9a-f]{64}$'
  );

ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_provenance_shape CHECK (
  engine_provenance_kind IS NULL
  OR (
    engine_provenance_kind = 'oci'
    AND engine_provenance ? 'imageDigest'
    AND engine_provenance->>'imageDigest' ~ '^sha256:[0-9a-f]{64}$'
  )
  OR (
    engine_provenance_kind = 'git'
    AND engine_provenance ? 'commit'
    AND engine_provenance ? 'repository'
    AND engine_provenance ? 'configDigest'
    AND engine_provenance->>'commit' ~ '^[0-9a-f]{40}$'
    AND length(engine_provenance->>'repository') > 0
    AND engine_provenance->>'configDigest' ~ '^sha256:[0-9a-f]{64}$'
  )
);

INSERT INTO ai_schema_migrations(version) VALUES ('003_git_config_provenance');

COMMIT;
