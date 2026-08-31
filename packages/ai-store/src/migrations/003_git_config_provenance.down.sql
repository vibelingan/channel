BEGIN;

ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_provenance_shape;
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
    AND engine_provenance->>'commit' ~ '^[0-9a-f]{40}$'
    AND length(engine_provenance->>'repository') > 0
  )
);

DELETE FROM ai_schema_migrations WHERE version = '003_git_config_provenance';

COMMIT;
