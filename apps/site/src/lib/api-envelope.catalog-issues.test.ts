import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogFailureIssue } from '@vibelingan-channel/shared/catalog-issues';
import { readApiEnvelope } from './api-envelope.ts';

test('API transport retains validated catalog recovery issues', async () => {
  const value = {
    ok: false,
    error: {
      code: 'CONFLICT',
      message: 'Product changed.',
      issues: [catalogFailureIssue('CONFLICT')],
    },
  };
  assert.deepEqual(await readApiEnvelope(new Response(JSON.stringify(value))), value);
});

test('API transport rejects malformed or private catalog issue payloads', async () => {
  for (const issues of [
    ['PRIVATE_TOKEN'],
    [{ ...catalogFailureIssue('CONFLICT'), path: 'PRIVATE_TOKEN' }],
    [{ ...catalogFailureIssue('CONFLICT'), message: 'PRIVATE_TOKEN' }],
    Array.from({ length: 51 }, () => catalogFailureIssue('CONFLICT')),
  ]) {
    assert.equal(
      await readApiEnvelope(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'CONFLICT', message: 'Product changed.', issues },
          }),
        ),
      ),
      null,
    );
  }
});

test('API errors without catalog issues keep their existing transport contract', async () => {
  const value = { ok: false, error: { code: 'FORBIDDEN', message: 'Permission required.' } };
  assert.deepEqual(await readApiEnvelope(new Response(JSON.stringify(value))), value);
});
