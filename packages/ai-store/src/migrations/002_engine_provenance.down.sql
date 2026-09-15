BEGIN;
ALTER TABLE ai_runs DROP CONSTRAINT IF EXISTS ai_runs_provenance_shape;
ALTER TABLE ai_runs DROP CONSTRAINT IF EXISTS ai_runs_provenance_paired;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS image_digest text;
UPDATE ai_runs SET image_digest = engine_provenance->>'imageDigest'
WHERE engine_provenance_kind = 'oci';
ALTER TABLE ai_runs DROP COLUMN IF EXISTS engine_provenance;
ALTER TABLE ai_runs DROP COLUMN IF EXISTS engine_provenance_kind;
DELETE FROM ai_schema_migrations WHERE version = '002_engine_provenance';
COMMIT;
