import assert from 'node:assert/strict';
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
  assert.ok(withPending.includes('3 new products to review'));
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
  assert.ok(html.includes('Disabled (not public)'));
  assert.ok(html.includes('AAEHBBhgAOVTpOKZBnRePx0I'));
  assert.ok(html.includes('Consumer Electronics &gt; Headphones'));
  assert.ok(html.includes('SY-T11'));
  assert.ok(html.includes('3 variants · 3 offers'));
  assert.ok(html.includes('USD 3.80–5.70 / unit · tiered from 2'));
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
