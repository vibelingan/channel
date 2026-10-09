import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type CollectionDoc, getCollection } from '@vibelingan-channel/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BatchUpdateFeedback } from './BatchUpdateFeedback.tsx';
import { ProductFamilyTab, ProductThumbnail } from './CollectionView.tsx';
import { PreviewModal } from './PreviewModal.tsx';
import { RecordForm } from './RecordForm.tsx';
import { pendingSupplierChange, splitForBatchPublish } from './review-reason.ts';

const pending = {
  _id: 'p-new',
  name: 'New Alibaba product',
  published: false,
  alibabaPrimarySourceKey: 'source-1',
  alibabaReviewPending: true,
  alibabaSourceImageUrls: ['https://sc04.alicdn.com/new-product.jpg'],
  alibabaSourceReview: {
    schemaVersion: 'alibaba-source-review-v1',
    provider: 'alibaba',
    externalProductId: 'AAEHBBhgAOVTpOKZBnRePx0I',
    sourceCategoryId: '201745901',
    sourceCategoryName: 'Consumer Electronics > Headphones',
    sourceListingStatus: 'published',
    variantCount: 3,
    offerCount: 3,
    modelNumbers: ['SY-T11'],
    optionNames: ['color', 'model number'],
    minimumOrderQuantity: 2,
    primaryPricing: {
      mode: 'tiered',
      currency: 'USD',
      minimumOrderQuantity: 2,
      tiers: [
        { minimumQuantity: 2, maximumQuantity: 499, unitAmountMinor: 570 },
        { minimumQuantity: 500, unitAmountMinor: 380 },
      ],
    },
  },
} as CollectionDoc;

test('pending product thumbnail renders New at the top-left overlay', () => {
  const html = renderToStaticMarkup(createElement(ProductThumbnail, { doc: pending }));
  assert.ok(html.includes('relative inline-block'));
  assert.ok(html.includes('-left-1 -top-1'));
  assert.ok(html.includes('New'));
});

test('family tab exposes an accessible notification dot only when pending', () => {
  const withPending = renderToStaticMarkup(
    createElement(ProductFamilyTab, {
      label: 'Headphones',
      value: 'headphones',
      selected: false,
      pendingCount: 3,
      onSelect: () => {},
    }),
  );
  // Counts every flagged product, not only new ones (MIU-23).
  assert.ok(withPending.includes('3 products to review'));
  assert.ok(!withPending.includes('new products'));
  const clear = renderToStaticMarkup(
    createElement(ProductFamilyTab, {
      label: 'Toys',
      value: 'toys',
      selected: false,
      pendingCount: 0,
      onSelect: () => {},
    }),
  );
  assert.ok(!clear.includes('to review'));
});

test('pending product preview offers an explicit admin review acknowledgement', () => {
  const html = renderToStaticMarkup(
    createElement(PreviewModal, {
      doc: pending,
      canMarkReviewed: true,
      onMarkReviewed: () => {},
      onClose: () => {},
      onEdit: () => {},
    }),
  );
  assert.ok(html.includes('New · review needed'));
  assert.ok(html.includes('Mark reviewed'));
  assert.ok(html.includes('Draft (not public)'));
  assert.ok(html.includes('Loading product preview'));
  assert.ok(html.includes('data-preview-scroll'));
  assert.ok(!html.includes('AAEHBBhgAOVTpOKZBnRePx0I'));
  assert.ok(!html.includes('Prepare detail review'));
  // The shared detail is loaded through the real authenticated API. Its loaded
  // prices/configurations and non-publication are covered by the formal E2E.
});

test('malformed source review data degrades without throwing or rendering attacker keys', () => {
  const html = renderToStaticMarkup(
    createElement(PreviewModal, {
      doc: { ...pending, alibabaSourceReview: { __proto__: { polluted: true } } },
      onClose: () => {},
      onEdit: () => {},
    }),
  );
  assert.ok(html.includes('New Alibaba product'));
  assert.ok(!html.includes('polluted'));
});

test('the badge names why a product needs review; nothing when it does not (MIU-23)', () => {
  const badge = (extra: object) =>
    renderToStaticMarkup(createElement(ProductThumbnail, { doc: { ...pending, ...extra } }));
  assert.match(badge({ alibabaReviewReason: 'changed' }), />Changed</);
  assert.match(badge({ alibabaReviewReason: 'removed' }), />Removed</);
  assert.match(badge({ alibabaReviewReason: 'edited' }), />Edited</);
  assert.match(badge({}), />New</, 'a pending row without a reason is new');
  assert.doesNotMatch(badge({ alibabaReviewPending: false }), /New|Changed|Removed|Edited/);
});

test('the preview chip names the reason; "Mark reviewed" is offered only for new products', () => {
  const preview = (extra: object) =>
    renderToStaticMarkup(
      createElement(PreviewModal, {
        doc: { ...pending, ...extra } as CollectionDoc,
        canMarkReviewed: true,
        onMarkReviewed: () => {},
        onClose: () => {},
        onEdit: () => {},
      }),
    );
  const changed = preview({ alibabaReviewReason: 'changed' });
  assert.ok(changed.includes('Changed · review needed'));
  assert.ok(!changed.includes('Mark reviewed'));
  assert.ok(preview({ alibabaReviewReason: 'new' }).includes('Mark reviewed'));
});

test('"Review changes" appears on a published product flagged changed, removed or edited (MIU-24, DEC-19)', () => {
  const preview = (extra: object) =>
    renderToStaticMarkup(
      createElement(PreviewModal, {
        doc: { ...pending, ...extra } as CollectionDoc,
        canMarkReviewed: true,
        onMarkReviewed: () => {},
        onReviewChanges: () => {},
        onUnpublish: () => {},
        onClose: () => {},
        onEdit: () => {},
      }),
    );
  const changed = preview({ published: true, alibabaReviewReason: 'changed' });
  assert.ok(changed.includes('>Review changes<'));
  assert.ok(!changed.includes('Approve changes'), 'approval happens in the edit form');
  assert.ok(
    changed.includes('href="/products/item/?id=p-new"'),
    'a link to compare with the live page',
  );
  assert.ok(!changed.includes('>Unpublish<'));
  const removed = preview({ published: true, alibabaReviewReason: 'removed' });
  assert.ok(removed.includes('>Review changes<'));
  assert.ok(removed.includes('>Unpublish<'), 'a removed source can also be taken offline');
  // Unpublished or new products use Publish / Mark reviewed instead.
  assert.ok(
    !preview({ published: false, alibabaReviewReason: 'changed' }).includes('Review changes'),
  );
  assert.ok(!preview({ published: true, alibabaReviewReason: 'new' }).includes('Review changes'));
  assert.ok(!preview({ published: true, alibabaReviewPending: false }).includes('Review changes'));
});

test('"Review changes" opens the edit form, where the supplier changes are decided', () => {
  const source = readFileSync(new URL('./CollectionView.tsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /onReviewChanges=\{\(\) => \{\s*setEditing\(previewing\);\s*setPreviewing\(null\);\s*\}\}/,
  );
  assert.ok(!source.includes('approveChangesMutation'), 'no approval straight from the preview');
});

test('a pending supplier change is a published product flagged changed or removed (DEC-12)', () => {
  const doc = (extra: object) => ({ ...pending, ...extra }) as CollectionDoc;
  assert.equal(
    pendingSupplierChange(doc({ published: true, alibabaReviewReason: 'changed' })),
    'Changed',
  );
  assert.equal(
    pendingSupplierChange(doc({ published: true, alibabaReviewReason: 'removed' })),
    'Removed',
  );
  // Publish is the approval for drafts; new and edited are not Alibaba changes.
  assert.equal(
    pendingSupplierChange(doc({ published: false, alibabaReviewReason: 'changed' })),
    null,
  );
  assert.equal(pendingSupplierChange(doc({ published: true, alibabaReviewReason: 'new' })), null);
  assert.equal(
    pendingSupplierChange(doc({ published: true, alibabaReviewReason: 'edited' })),
    null,
  );
  assert.equal(
    pendingSupplierChange(
      doc({ published: true, alibabaReviewPending: false, alibabaReviewReason: 'changed' }),
    ),
    null,
  );
});

test('the edit form warns above Save when saving would publish pending Alibaba changes (MIU-25)', () => {
  const products = getCollection('products');
  assert.ok(products);
  const form = (extra: object) =>
    renderToStaticMarkup(
      createElement(RecordForm, {
        collection: products,
        title: 'Edit Product',
        initial: { ...pending, ...extra } as CollectionDoc,
        submitting: false,
        error: null,
        onSubmit: () => undefined,
        onCancel: () => undefined,
        onSeeChanges: () => undefined,
      }),
    );
  const changed = form({ published: true, alibabaReviewReason: 'changed' });
  assert.ok(
    changed.includes(
      'Alibaba data changed since the last approval. Saving publishes these changes too.',
    ),
  );
  assert.ok(changed.includes('See changes'));
  assert.ok(
    changed.indexOf('data-pending-supplier-change') < changed.indexOf('type="submit"'),
    'the notice sits above Save',
  );
  // Screen readers hear the warning with the Save button.
  const noticeId = /<p id="([^"]+)">Alibaba data changed/.exec(changed)?.[1];
  assert.ok(noticeId);
  assert.match(changed, new RegExp(`type="submit"[^>]*aria-describedby="${noticeId}"`));
  const removed = form({ published: true, alibabaReviewReason: 'removed' });
  assert.ok(removed.includes('removed on Alibaba since the last approval'));
  for (const quiet of [
    { published: true, alibabaReviewPending: false },
    { published: true, alibabaReviewReason: 'new' },
    { published: false, alibabaReviewReason: 'changed' },
  ]) {
    const html = form(quiet);
    assert.ok(!html.includes('data-pending-supplier-change'), JSON.stringify(quiet));
    assert.doesNotMatch(html, /type="submit"[^>]*aria-describedby/, JSON.stringify(quiet));
  }
});

test('"See changes" opens a read-only preview, so nothing changes under the open form', () => {
  const source = readFileSync(new URL('./CollectionView.tsx', import.meta.url), 'utf8');
  assert.match(source, /onSeeChanges=\{\(\) => setChangesPreview\(editing\)\}/);
  const preview = source.slice(source.indexOf('{changesPreview && ('));
  const element = preview.slice(0, preview.indexOf('/>'));
  assert.ok(element.includes('doc={changesPreview}'));
  // It still shows the supplier preview and the live-page link (review P2).
  assert.ok(element.includes('canMarkReviewed={canReviewAlibabaProducts}'));
  for (const action of ['onReviewChanges', 'onUnpublish', 'onMarkReviewed'])
    assert.ok(!element.includes(action), `${action} must not be offered over the form`);
});

test('batch Publish skips products with Alibaba changes to review, live or not (DEC-19)', () => {
  const live = { ...pending, _id: 'live', name: 'Live headset', published: true } as CollectionDoc;
  const flagged = { ...live, _id: 'flagged', alibabaReviewReason: 'changed' } as CollectionDoc;
  const removedDraft = {
    ...pending,
    _id: 'removed-draft',
    alibabaReviewReason: 'removed',
  } as CollectionDoc;
  const fresh = { ...pending, _id: 'fresh' } as CollectionDoc;
  assert.deepEqual(
    splitForBatchPublish([live, flagged, removedDraft, fresh]).map((group) =>
      group.map((doc) => doc._id),
    ),
    [
      ['flagged', 'removed-draft'],
      ['live', 'fresh'],
    ],
  );
  const source = readFileSync(new URL('./CollectionView.tsx', import.meta.url), 'utf8');
  assert.match(source, /splitForBatchPublish\(docs\)/);
  assert.match(source, /setSkippedOnly\(\{ skipped, names \}\)/, 'nothing left: no request');
  // The single-row switch opens Edit for a flagged product instead of publishing it.
  assert.match(source, /\? setEditing\(row\.original\)\s*: patch\(row\.original\._id/);
  // A publish that kept the flag says so.
  assert.match(source, /data-still-flagged/);
  const feedback = renderToStaticMarkup(
    createElement(BatchUpdateFeedback, {
      result: { updated: 1, items: [], failures: [] },
      names: { flagged: 'Changed headset' },
      published: true,
      skipped: ['flagged'],
      onDismiss: () => {},
    }),
  );
  assert.ok(feedback.includes('1 published'));
  assert.ok(feedback.includes('Skipped (Alibaba changes to review)'));
  assert.ok(feedback.includes('Changed headset'));
  assert.ok(feedback.includes('Open each in Edit'));
});

test('the product list jumps to a typed page number, kept within the pages that exist', async () => {
  const { PageJump, requestedPage } = await import('./PageJump.tsx');
  assert.equal(requestedPage('7', 56), 7);
  assert.equal(requestedPage(' 99 ', 56), 56);
  assert.equal(requestedPage('0', 56), 1);
  assert.equal(requestedPage('abc', 56), null);
  const html = renderToStaticMarkup(
    createElement(PageJump, { page: 3, pageCount: 56, onJump: () => {} }),
  );
  assert.match(
    html,
    /<label[^>]*>Page<\/label><input[^>]*type="number"[^>]*max="56"[^>]*value="3"/,
  );
  assert.ok(html.includes('aria-label="Go to page"'));
});
