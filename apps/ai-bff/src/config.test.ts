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
