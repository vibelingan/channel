import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const compose = parse(readFileSync(new URL('../docker-compose.ai.yml', import.meta.url), 'utf8'));
const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const probeEnvExample = readFileSync(new URL('../.env.ai-probe.example', import.meta.url), 'utf8');
const localAiEnvExample = readFileSync(new URL('../.env.ai.example', import.meta.url), 'utf8');
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
const configureSource = readFileSync(
  new URL('./ai-configure-workspace.mjs', import.meta.url),
  'utf8',
);
const ingestSource = readFileSync(new URL('./ai-ingest-content.mjs', import.meta.url), 'utf8');

test('AI PostgreSQL host port can be overridden without editing compose', () => {
  // The port number is overridable; the host interface is NOT. Without the
  // 127.0.0.1 prefix this publishes a database with static credentials on every
  // network the machine is attached to. scripts/compose-ports.test.mjs enforces
  // the prefix on every service; this asserts the override still works with it.
  assert.deepEqual(compose.services?.postgres?.ports, [
    '127.0.0.1:${AI_POSTGRES_PORT:-55432}:5432',
  ]);
  assert.match(localAiEnvExample, /^AI_POSTGRES_PORT=55432$/m);
  assert.equal(
    rootPackage.scripts?.['dev:ai:full'],
    'docker compose --env-file .env.ai -f docker-compose.ai.yml up -d postgres anythingllm',
  );
});

test('AI KB probe has a secret-safe local environment contract', () => {
  assert.equal(
    rootPackage.scripts?.['test:ai:kb'],
    'node --env-file-if-exists=.env.ai --env-file-if-exists=.env.ai-probe scripts/probe-anythingllm.mjs',
  );
  assert.match(probeEnvExample, /^ANYTHINGLLM_BASE_URL=https:\/\//m);
  assert.match(probeEnvExample, /^ANYTHINGLLM_API_KEY=$/m);
  assert.match(probeEnvExample, /^ANYTHINGLLM_WORKSPACE_SLUG=$/m);
  assert.doesNotMatch(probeEnvExample, /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/);
  assert.match(gitignore, /^\.env\.ai-probe$/m);
  assert.match(gitignore, /^!\.env\.ai-probe\.example$/m);
  assert.match(gitignore, /^\.ai-kb-evidence\.json$/m);
});

test('host-side local KB setup never uses the Docker-only engine hostname', () => {
  assert.match(localAiEnvExample, /^ANYTHINGLLM_BASE_URL=http:\/\/anythingllm:3001$/m);
  assert.match(localAiEnvExample, /^ANYTHINGLLM_LOCAL_ADMIN_URL=http:\/\/127\.0\.0\.1:53001$/m);
  for (const source of [configureSource, ingestSource]) {
    assert.match(source, /process\.env\.ANYTHINGLLM_LOCAL_ADMIN_URL/);
    assert.doesNotMatch(source, /process\.env\.ANYTHINGLLM_BASE_URL/);
  }
  assert.match(rootPackage.scripts?.['ai:configure'], /--env-file-if-exists=\.env\.ai/);
  assert.match(rootPackage.scripts?.['ai:ingest'], /--env-file-if-exists=\.env\.ai/);
});
