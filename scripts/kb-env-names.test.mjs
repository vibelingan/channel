/**
 * The knowledge base the assistant uses is not AnythingLLM; it only speaks the
 * same HTTP API the adapter was first written against. Its settings are named
 * KB_* so an operator setting up a deployment is not sent looking for an
 * AnythingLLM install. This fails if an old setting name comes back into
 * anything that configures, runs, documents or tests the services.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const SURFACES = [
  '.env.ai.example',
  '.env.ai-probe.example',
  '.env.ai-runtime.example',
  '.github/workflows/ci.yml',
  '.github/workflows/deploy-ai-cloudrun.yml',
  '.github/workflows/deploy-test.yml',
  'apps/ai-worker/src/worker.ts',
  'docker-compose.ai.yml',
  'packages/ai-engine-anythingllm/src/engine.ts',
  'scripts/ai-configure-workspace.mjs',
  'scripts/ai-ingest-content.mjs',
  'scripts/ai-cloudrun-deploy-plan.mjs',
  'scripts/ai-local-substrate.test.mjs',
  'scripts/cloudrun-manifest.test.mjs',
  'scripts/cloudrun-service-manifest.mjs',
  'scripts/compose-ports.test.mjs',
  'scripts/deploy-ai-cloudrun.mjs',
  'scripts/generate-local-anythingllm-key.mjs',
  'scripts/generate-local-anythingllm-key.test.mjs',
  'scripts/probe-anythingllm.mjs',
  'docs/ai-platform/LOCAL-DEV-RUNBOOK.md',
  'docs/ai-platform/PRODUCTION-KB-CLOUDRUN-RUNBOOK.md',
  'docs/ai-platform/PHASE-1-REMOTE-KB-HANDOFF.md',
];

const OLD_NAME = /\b(?:ANYTHINGLLM_[A-Z0-9_]+|ALLOW_INSECURE_ANYTHINGLLM)\b/g;

test('knowledge-base settings are named KB_*, never by the old AnythingLLM names', () => {
  for (const file of SURFACES) {
    const found = readFileSync(join(repoRoot, file), 'utf8').match(OLD_NAME) ?? [];
    assert.deepEqual(found, [], `${file} still uses ${[...new Set(found)].join(', ')}`);
  }
});

test('the deploy manifest passes every KB setting the worker reads', () => {
  const manifest = readFileSync(join(repoRoot, 'scripts/cloudrun-service-manifest.mjs'), 'utf8');
  const worker = readFileSync(join(repoRoot, 'apps/ai-worker/src/worker.ts'), 'utf8');
  for (const name of [
    'KB_BASE_URL',
    'KB_API_KEY',
    'KB_WORKSPACE_SLUG',
    'KB_WORKSPACE_ID',
    'KB_CITATIONS_VERIFIED',
    'KB_CREDENTIAL_ROTATION',
  ]) {
    assert.match(manifest, new RegExp(`\\b${name}\\b`), `the manifest does not pass ${name}`);
    assert.match(worker, new RegExp(`\\b${name}\\b`), `the worker does not read ${name}`);
  }
});
