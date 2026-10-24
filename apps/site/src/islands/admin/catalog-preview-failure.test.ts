import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogFailureIssue } from '@vibelingan-channel/shared/catalog-issues';
import { AdminApiError } from './api.ts';
import { catalogPreviewFailure } from './catalog-preview-failure.ts';

test('a real structured API rejection preserves safe issues without decoding website detail', () => {
  const issues = [catalogFailureIssue('SOURCE_NOT_READY')];
  assert.deepEqual(
    catalogPreviewFailure(new AdminApiError('CONFLICT', 'Source data needs attention.', issues)),
    { message: 'Source data needs attention.', issues },
  );
});

test('expired authentication has a sign-in recovery even when the legacy response omitted issues', () => {
  const failure = catalogPreviewFailure(new AdminApiError('UNAUTHORIZED', 'Sign in again.'));
  assert.equal(failure.issues[0]?.remedy, 'sign-in');
});

test('unexpected exceptions do not turn their arbitrary message into product UI', () => {
  for (const cause of [new Error('private-raw-source-value'), 'private-token', null]) {
    const failure = catalogPreviewFailure(cause);
    assert.match(failure.message, /preview.*Retry/i);
    assert.doesNotMatch(JSON.stringify(failure), /private-/);
    assert.deepEqual(failure.issues, []);
  }
});
