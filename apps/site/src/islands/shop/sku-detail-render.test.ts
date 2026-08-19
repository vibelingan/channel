import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CatalogContent } from '../../i18n/catalog.ts';
import { boundedGalleryImages } from './Gallery.tsx';
import { SkuDetailView, type SkuDetailViewState } from './SkuDetailPage.tsx';

const content = {
  list: {
    loadingLabel: 'Loading products',
    errorLabel: 'Load failed',
    retryLabel: 'Try Again',
    moqLabel: 'MOQ',
  },
  detail: {
    backLabel: 'Back to products',
    moqLabel: 'Minimum Order Quantity',
    unitPriceLabel: 'Unit price',
    wholesaleLabel: 'Wholesale price',
    inquiryCta: 'Request a Quote',
    oemEyebrow: 'OEM / ODM Programs',
    oemHeading: 'Build This Product for Your Market',
    oemBody: 'Share your requirements with our OEM team.',
    relatedHeading: 'Related Products',
    notFound: 'Product not found.',
  },
} as CatalogContent;

const renderView = (state: SkuDetailViewState) =>
  renderToStaticMarkup(
    createElement(SkuDetailView, {
      content,
      state,
      onRetry: () => undefined,
    }),
  );

test('detail gallery preserves order and caps product media at nine', () => {
  const images = Array.from({ length: 10 }, (_, index) => ` /image-${index + 1}.jpg `);
  assert.deepEqual(
    boundedGalleryImages(images),
    images.slice(0, 9).map((image) => image.trim()),
  );
});

test('detail loading, not-found, and retryable error states are mutually exclusive', () => {
  const loading = renderView({ status: 'loading' });
  assert.match(loading, /Loading products/);
  assert.doesNotMatch(loading, /Try Again|Product not found|data-sku-detail/);

  const notFound = renderView({ status: 'not-found' });
  assert.match(notFound, /Product not found/);
  assert.doesNotMatch(notFound, /Try Again|data-sku-detail/);

  const error = renderView({ status: 'error' });
  assert.match(error, /role="alert"/);
  assert.match(error, /Try Again/);
  assert.doesNotMatch(error, /Product not found|data-sku-detail/);
});

test('published detail renders facts, quote pricing, fallback media, and valid related links', () => {
  const markup = renderView({
    status: 'ready',
    product: {
      _id: 'current',
      name: 'VisionClip',
      slug: 'visionclip',
      productFamily: 'ai-gadgets',
      skuCode: 'AI-100',
      series: 'Vision',
      modName: 'VC-1',
      modType: 'Camera',
      description: 'Compact connected camera.',
      moq: 100,
      images: [],
    },
    related: [
      {
        _id: 'current',
        name: 'Duplicate current',
        slug: 'visionclip',
        productFamily: 'ai-gadgets',
      },
      { _id: 'related', name: 'Translator', slug: 'translator', productFamily: 'ai-gadgets' },
      { _id: 'wrong', name: 'Wrong family', slug: 'wrong', productFamily: 'toys' },
      { _id: 'missing', name: 'Missing slug', productFamily: 'ai-gadgets' },
    ],
  });
  assert.match(markup, /data-sku-detail="current"/);
  assert.match(markup, /data-product-media="fallback"/);
  assert.match(markup, /AI-100|Vision|VC-1|Camera|MOQ 100/);
  assert.match(markup, /Request a Quote/);
  assert.match(markup, /OEM \/ ODM Programs|Build This Product for Your Market/);
  assert.match(markup, /href="\/products\/item\/\?slug=translator"/);
  assert.doesNotMatch(markup, /Duplicate current|Wrong family|Missing slug/);
  assert.doesNotMatch(markup, /VIP|vipPrice|video/iu);
});
