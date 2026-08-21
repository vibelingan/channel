import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ConfigError, loadConfig } from './config.ts';

const valid = {
  DATABASE_URL: 'postgres://ai:ai@localhost:55432/ai_assistant',
  PORT: '8080',
  CORS_ALLOWED_ORIGINS: 'https://example.com',
};

test('accepts a complete configuration', () => {
  const c = loadConfig(valid);
  assert.equal(c.port, 8080);
  assert.deepEqual(c.corsAllowedOrigins, ['https://example.com']);
});

test('refuses to start without a database url', () => {
  assert.throws(() => loadConfig({ ...valid, DATABASE_URL: '' }), /DATABASE_URL/);
});

test('refuses an empty CORS allowlist rather than defaulting to permissive', () => {
  assert.throws(() => loadConfig({ ...valid, CORS_ALLOWED_ORIGINS: '' }), /CORS_ALLOWED_ORIGINS/);
});

test("refuses '*' in the CORS allowlist", () => {
  // Wildcard plus credentials is the classic hole; the assistant carries a
  // conversation credential cross-origin, so this must never be reachable.
  assert.throws(() => loadConfig({ ...valid, CORS_ALLOWED_ORIGINS: '*' }), /never valid/);
});

test('reports every problem at once, not just the first', () => {
  try {
    loadConfig({ DATABASE_URL: '', PORT: 'not-a-port', CORS_ALLOWED_ORIGINS: '' });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /DATABASE_URL/);
    assert.match(error.message, /PORT/);
    assert.match(error.message, /CORS_ALLOWED_ORIGINS/);
  }
});

test('defaults the port when unset but still validates it', () => {
  const c = loadConfig({ ...valid, PORT: undefined });
  assert.equal(c.port, 8080);
});

const BASE_ENV = {
  DATABASE_URL: 'postgres://ai:ai@localhost:55432/ai_assistant',
  CORS_ALLOWED_ORIGINS: 'https://site.example',
};

test('the local harness is off unless explicitly switched on', () => {
  assert.equal(loadConfig({ ...BASE_ENV }).localHarness, false);
  assert.equal(loadConfig({ ...BASE_ENV, AI_LOCAL_HARNESS: '0' }).localHarness, false);
  assert.equal(loadConfig({ ...BASE_ENV, AI_LOCAL_HARNESS: 'true' }).localHarness, false);
  assert.equal(loadConfig({ ...BASE_ENV, AI_LOCAL_HARNESS: '1' }).localHarness, true);
});

test('production refuses to start with the harness flag set', () => {
  // Refuses rather than ignores. A silently downgraded harness would leave an
  // operator believing the assistant is reachable when it answers nobody.
  for (const production of [{ NODE_ENV: 'production' }, { APP_ENV: 'production' }]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, ...production, AI_LOCAL_HARNESS: '1' }),
      /AI_LOCAL_HARNESS/,
      `production was not detected via ${JSON.stringify(production)}`,
    );
  }
});

test('either production signal alone is enough to refuse the harness', () => {
  // A deployment that sets only one of the two is still production. Requiring
  // both to agree would let a single missing variable open the harness.
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        AI_LOCAL_HARNESS: '1',
      }),
    /AI_LOCAL_HARNESS/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'development',
        APP_ENV: 'production',
        AI_LOCAL_HARNESS: '1',
      }),
    /AI_LOCAL_HARNESS/,
  );
});

test('the local compose environment, deployed to production, refuses to start', () => {
  // The exact accident the review named: someone copies docker-compose.ai.yml
  // onto a server. Compose sets NODE_ENV=development and the harness flag, so
  // the platform's own APP_ENV=production is what catches it.
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'development',
        AI_LOCAL_HARNESS: '1',
        APP_ENV: 'production',
      }),
    /AI_LOCAL_HARNESS/,
  );
});

test('production starts normally when the harness flag is absent', () => {
  const config = loadConfig({ ...BASE_ENV, NODE_ENV: 'production', APP_ENV: 'production' });
  assert.equal(config.localHarness, false);
});

test('the harness refusal explains the consequence, not just the rule', () => {
  try {
    loadConfig({ ...BASE_ENV, NODE_ENV: 'production', AI_LOCAL_HARNESS: '1' });
    assert.fail('expected a refusal');
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /rate limiting/, 'the refusal does not say why it matters');
  }
});
