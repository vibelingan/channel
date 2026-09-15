-- Replace `image_digest` with a discriminated provenance record.
--
-- The worker required AI_ENGINE_IMAGE_DIGEST and wrote it to every run. The
-- knowledge base it now talks to is a Git checkout on a CVM, not a container,
-- so the only values available were a Git SHA or a placeholder. Either one is a
-- lie in a column whose name promises an OCI digest, and it is exactly the kind
-- of lie that survives: an auditor reading `image_digest` believes they can
-- `docker pull` it and reproduce the run.
--
-- A run must still be attributable to an exact artifact. So the shape becomes
-- explicit about WHICH kind of artifact it is naming, and the database refuses
-- a value that does not match its declared kind.

BEGIN;

ALTER TABLE ai_runs ADD COLUMN engine_provenance_kind text;
ALTER TABLE ai_runs ADD COLUMN engine_provenance jsonb;

-- Anything already recorded was, by the old contract, an OCI digest. In
-- practice the old field sometimes held a Git SHA or placeholder. Preserve
-- that claim in the audit log, but do not relabel it as OCI provenance: an
-- honest NULL is safer than a value an operator believes they can pull.
INSERT INTO audit_events(conversation_id, actor_type, action, metadata)
SELECT conversation_id,
       'system',
       'engine_provenance_legacy_invalidated',
       jsonb_build_object('runId', id, 'legacyImageDigestClaim', image_digest)
FROM ai_runs
WHERE image_digest IS NOT NULL
  AND image_digest !~ '^sha256:[0-9a-f]{64}$';

UPDATE ai_runs
SET engine_provenance_kind = 'oci',
    engine_provenance = jsonb_build_object('imageDigest', image_digest)
WHERE image_digest ~ '^sha256:[0-9a-f]{64}$';

ALTER TABLE ai_runs DROP COLUMN image_digest;

-- Both columns present or both absent: a kind with no record, or a record with
-- no kind, is unreadable provenance dressed as provenance.
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_provenance_paired
  CHECK ((engine_provenance_kind IS NULL) = (engine_provenance IS NULL));

-- The discriminator is closed, and each arm must carry its own required fields.
-- Enforced here rather than only in TypeScript because the column outlives any
-- one process, and a row written by a future service must obey it too.
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

INSERT INTO ai_schema_migrations(version) VALUES ('002_engine_provenance');

COMMIT;
