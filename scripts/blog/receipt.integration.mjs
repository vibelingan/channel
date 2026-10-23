import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArticleDraft } from '../../packages/articles/src/drafts.ts';
import { createArticleReleaseStore } from '../../packages/articles/src/release-store.ts';
const receipt = JSON.parse(readFileSync(0, 'utf8'));
let now = Date.parse(receipt.acceptedAt) - 10000;
const draft = createArticleDraft({
  id: 'receipt-article',
  editorId: 'receipt-admin',
  now: new Date(now).toISOString(),
  content: {
    title: 'Receipt test',
    slug: 'receipt-test',
    authorName: 'Test',
    body: {
      schemaVersion: 1,
      document: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Receipt test body' }] }],
      },
    },
  },
});
let rows = new Map([
  ['users/receipt-admin', { _id: 'receipt-admin', role: 'admin', status: 'active' }],
  [
    'articleDrafts/receipt-article',
    {
      _id: draft.id,
      draft,
      requestId: 'create',
      requestActorId: 'receipt-admin',
      requestHash: 'a'.repeat(64),
    },
  ],
]);
const worker = createArticleReleaseStore(
  async (operation) => {
    const next = structuredClone(rows);
    let wrote = false;
    const result = await operation({
      read: async (collection, id) => {
        assert(!wrote);
        return structuredClone(next.get(`${collection}/${id}`) ?? null);
      },
      write: async (collection, id, value) => {
        wrote = true;
        next.set(`${collection}/${id}`, { ...structuredClone(value), _id: id });
      },
    });
    rows = next;
    return result;
  },
  () => now,
);
const task = await worker.request('receipt-admin', {
  operation: 'publish',
  articleId: draft.id,
  expectedRevision: 1,
  requestId: 'publish',
});
const claimed = await worker.claim(task.id, 'receipt-worker');
await worker.markDeploying(claimed.guard);
now = Date.parse(receipt.acceptedAt) + 1000;
if (process.argv[2] === 'restored') {
  await worker.restored(claimed.guard, receipt);
  const latest = await worker.latest('receipt-admin', draft.id);
  assert.equal(latest.error, 'RESTORED');
} else {
  const done = await worker.complete(claimed.guard, receipt);
  assert.equal(done.state, 'SUCCEEDED');
  assert(rows.get('articleAccepted/receipt-article').publication);
}
