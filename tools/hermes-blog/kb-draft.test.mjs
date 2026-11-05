import assert from 'node:assert/strict';
import test from 'node:test';
import { kbDraftRequest } from './kb-draft.mjs';
const binding = {
  siteId: 'supplychainsai.com',
  integrationId: 'hermes-client',
  workspaceId: 'customer-one',
};
const source = {
  documentId: 42,
  workspaceId: 'customer-one',
  article: {
    title: 'A useful article',
    format: 'markdown',
    body: '## Before ordering\n\nConfirm your requirements.',
  },
};
test('one KB document keeps its website request identity across replay, process restart and later edits', () => {
  const first = kbDraftRequest(binding, source);
  assert.deepEqual(kbDraftRequest(binding, structuredClone(source)), first);
  const edited = kbDraftRequest(binding, {
    ...source,
    article: { ...source.article, title: 'Edited' },
  });
  assert.equal(edited.idempotencyKey, first.idempotencyKey);
  assert.equal(edited.externalTaskId, first.externalTaskId);
  assert.notEqual(edited.title, first.title);
  assert.notEqual(
    kbDraftRequest(binding, { ...source, documentId: 43 }).idempotencyKey,
    first.idempotencyKey,
  );
});
test('workspace and site binding cannot come from a model or another customer document', () => {
  for (const input of [
    { ...source, workspaceId: 'other' },
    { ...source, documentId: 0 },
    { ...source, documentId: '42' },
    { ...source, publish: true },
    { ...source, article: { ...source.article, idempotencyKey: 'override' } },
  ])
    assert.throws(() => kbDraftRequest(binding, input));
  assert.throws(() => kbDraftRequest({ ...binding, siteId: 'other.example' }, source));
});
