import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const compose = parse(readFileSync(new URL('../docker-compose.ai.yml', import.meta.url), 'utf8'));
const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const probeEnvExample = readFileSync(new URL('../.env.ai-probe.example', import.meta.url), 'utf8');
const localAiEnvExample = readFileSync(new URL('../.env.ai.example', import.meta.url), 'utf8');
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

test('AI PostgreSQL host port can be overridden without editing compose', () => {
  assert.deepEqual(compose.services?.postgres?.ports, ['${AI_POSTGRES_PORT:-55432}:5432']);
  assert.match(localAiEnvExample, /^AI_POSTGRES_PORT=55432$/m);
  assert.equal(
    rootPackage.scripts?.['dev:ai:full'],
    'docker compose --env-file .env.ai -f docker-compose.ai.yml up -d postgres anythingllm',
  );
});

test('AI KB probe has a secret-safe local environment contract', () => {
  assert.equal(
    rootPackage.scripts?.['test:ai:kb'],
    'node --env-file-if-exists=.env.ai-probe scripts/probe-anythingllm.mjs',
  );
  assert.match(probeEnvExample, /^ANYTHINGLLM_BASE_URL=https:\/\//m);
  assert.match(probeEnvExample, /^ANYTHINGLLM_API_KEY=$/m);
  assert.match(probeEnvExample, /^ANYTHINGLLM_WORKSPACE_SLUG=$/m);
  assert.doesNotMatch(probeEnvExample, /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/);
  assert.match(gitignore, /^\.env\.ai-probe$/m);
  assert.match(gitignore, /^!\.env\.ai-probe\.example$/m);
});
