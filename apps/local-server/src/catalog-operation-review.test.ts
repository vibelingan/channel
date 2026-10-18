import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { CatalogIssueSchema } from '@vibelingan-channel/shared/catalog-issues';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { incomingDigest } from '../../functions/admin/src/catalog-supplier-review.ts';
import { coldOwnedMedia, workspace } from './testing/catalog-operation-workspace.ts';

async function publish(
  h: Awaited<ReturnType<typeof workspace>>,
  config: Awaited<ReturnType<typeof coldOwnedMedia>>['config'],
  values = {},
) {
  const scope = await h.start('publish', values);
  for (let step = 0; step < 40; step++) {
    const response = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      config,
    );
    if (!response.ok) return response;
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    if (status.state === 'complete') return response;
  }
  assert.fail('Original operation did not reach a final result');
}
for (const reason of ['new', 'legacy', 'changed', 'removed', 'edited'])
  test(`default publication atomically acknowledges the current ${reason} review`, async (t) => {
    const h = await workspace(t, reason === 'edited' ? undefined : 0, true);
    const media = await coldOwnedMedia(h);
    const rows = JSON.parse(h.bytes());
    Object.assign(rows.products[0], {
      alibabaReviewPending: true,
      ...(reason === 'legacy' ? {} : { alibabaReviewReason: reason }),
    });
    writeFileSync(h.file, JSON.stringify(rows));
    const values = ['changed', 'removed'].includes(reason)
      ? {
          supplierDecisions: {
            description: {
              choice: 'keep',
              incomingDigest: incomingDigest('description', 'Supplier description'),
            },
          },
        }
      : {};
    const result = await publish(h, media.config, values);
    assert.ok(result.ok, JSON.stringify(result));
    const status = CatalogProductOperationStatusSchema.parse(result.data);
    assert.ok(status.state === 'complete');
    const saved = JSON.parse(h.bytes()).products[0];
    assert.equal(saved.published, true);
    assert.equal(saved.alibabaReviewPending, false);
    assert.equal(saved.alibabaReviewReason, null);
    assert.equal(saved.alibabaReviewedByUserId, 'admin');
    assert.equal(saved.alibabaReviewedAt, saved.catalogDetailApprovalReceipt.approvedAt);
    assert.equal(saved.description, reason === 'edited' ? 'Original draft' : 'Website description');
    assert.equal(status.current, true);
  });

test('an undecided current supplier description has a review-change fallback without publication', async (t) => {
  const h = await workspace(t, 0, true);
  const media = await coldOwnedMedia(h);
  const rows = JSON.parse(h.bytes());
  Object.assign(rows.products[0], { alibabaReviewPending: true, alibabaReviewReason: 'changed' });
  writeFileSync(h.file, JSON.stringify(rows));
  const result = await publish(h, media.config);
  assert.ok(!result.ok, JSON.stringify(result));
  assert.ok(
    CatalogIssueSchema.array()
      .parse(Reflect.get(result.error, 'issues'))
      .some((issue) => issue.path === 'description' && issue.remedy === 'review-change'),
    JSON.stringify(result),
  );
  const saved = JSON.parse(h.bytes()).products[0];
  assert.equal(saved.published, false);
  assert.equal(saved.alibabaReviewPending, true);
});

test('a newer source public digest cannot be acknowledged by an older original approval', async (t) => {
  const h = await workspace(t, 0, true);
  const media = await coldOwnedMedia(h);
  const rows = JSON.parse(h.bytes());
  Object.assign(rows.products[0], {
    alibabaReviewPending: true,
    alibabaReviewReason: 'new',
    alibabaSourcePublicDigest: 'e'.repeat(64),
  });
  writeFileSync(h.file, JSON.stringify(rows));
  const result = await publish(h, media.config);
  assert.ok(!result.ok, JSON.stringify(result));
  assert.ok(
    CatalogIssueSchema.array()
      .parse(Reflect.get(result.error, 'issues'))
      .some((issue) => issue.remedy === 'resync'),
    JSON.stringify(result),
  );
  const saved = JSON.parse(h.bytes()).products[0];
  assert.equal(saved.published, false);
  assert.equal(saved.alibabaReviewPending, true);
});

for (const choice of ['applied-incoming', 'unapplied-incoming', 'stale-keep', 'already-equal'])
  test(`default supplier review enforces ${choice}`, async (t) => {
    const h = await workspace(t, 0, true);
    const media = await coldOwnedMedia(h);
    const rows = JSON.parse(h.bytes());
    Object.assign(rows.products[0], { alibabaReviewPending: true, alibabaReviewReason: 'changed' });
    if (choice === 'already-equal') rows.products[0].description = 'Supplier description';
    writeFileSync(h.file, JSON.stringify(rows));
    const values =
      choice === 'already-equal'
        ? {}
        : {
            ...(choice === 'applied-incoming' ? { description: 'Supplier description' } : {}),
            supplierDecisions: {
              description: {
                choice: choice === 'stale-keep' ? 'keep' : 'incoming',
                incomingDigest:
                  choice === 'stale-keep'
                    ? 'f'.repeat(64)
                    : incomingDigest('description', 'Supplier description'),
              },
            },
          };
    const result = await publish(h, media.config, values);
    const expected = ['applied-incoming', 'already-equal'].includes(choice);
    assert.equal(result.ok, expected, JSON.stringify(result));
    if (!result.ok)
      assert.ok(
        CatalogIssueSchema.array()
          .parse(Reflect.get(result.error, 'issues'))
          .every((issue) => issue.remedy === 'review-change'),
      );
    const saved = JSON.parse(h.bytes()).products[0];
    assert.equal(saved.published, expected);
    assert.equal(saved.alibabaReviewPending, !expected);
    if (expected) assert.equal(saved.description, 'Supplier description');
  });

test('a linked Edited review still refuses a newer public source digest', async (t) => {
  const h = await workspace(t, 0, true);
  const media = await coldOwnedMedia(h);
  const rows = JSON.parse(h.bytes());
  Object.assign(rows.products[0], {
    alibabaReviewPending: true,
    alibabaReviewReason: 'edited',
    alibabaSourcePublicDigest: 'e'.repeat(64),
  });
  writeFileSync(h.file, JSON.stringify(rows));
  const result = await publish(h, media.config);
  assert.ok(!result.ok, JSON.stringify(result));
  assert.ok(
    CatalogIssueSchema.array()
      .parse(Reflect.get(result.error, 'issues'))
      .some((issue) => issue.remedy === 'resync'),
  );
  const saved = JSON.parse(h.bytes()).products[0];
  assert.equal(saved.published, false);
  assert.equal(saved.alibabaReviewPending, true);
});
