import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductFamilyTab, ProductThumbnail } from './CollectionView.tsx';
import { PreviewModal } from './PreviewModal.tsx';

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

test('"Approve changes" appears only on a published product flagged changed, removed or edited (MIU-24)', () => {
  const preview = (extra: object) =>
    renderToStaticMarkup(
      createElement(PreviewModal, {
        doc: { ...pending, ...extra } as CollectionDoc,
        canMarkReviewed: true,
        onMarkReviewed: () => {},
        onApproveChanges: () => {},
        onUnpublish: () => {},
        onClose: () => {},
        onEdit: () => {},
      }),
    );
  const changed = preview({ published: true, alibabaReviewReason: 'changed' });
  assert.ok(changed.includes('Approve changes'));
  assert.ok(!changed.includes('>Unpublish<'));
  const removed = preview({ published: true, alibabaReviewReason: 'removed' });
  assert.ok(removed.includes('Approve changes'));
  assert.ok(removed.includes('>Unpublish<'), 'a removed source can also be taken offline');
  // Unpublished or new products use Publish / Mark reviewed instead.
  assert.ok(
    !preview({ published: false, alibabaReviewReason: 'changed' }).includes('Approve changes'),
  );
  assert.ok(!preview({ published: true, alibabaReviewReason: 'new' }).includes('Approve changes'));
  assert.ok(!preview({ published: true, alibabaReviewPending: false }).includes('Approve changes'));
});

test('"Approve changes" publishes through the full approval path', () => {
  const source = readFileSync(new URL('./CollectionView.tsx', import.meta.url), 'utf8');
  // updateRecord with published: true runs prepare → begin/page/finish → publish
  // for a linked product, and the server then clears the review flag (MIU-21).
  assert.match(
    source,
    /approveChangesMutation = useMutation\(\{\s*mutationFn: \(productId: string\) =>\s*updateRecord\('products', productId, \{ published: true \}\)/,
  );
  assert.match(
    source,
    /onApproveChanges=\{\(\) => approveChangesMutation\.mutate\(previewing\._id\)\}/,
  );
});
