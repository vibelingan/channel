import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import { Children, type ReactElement, type ReactNode, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogDetail } from '../../catalog/presentation/CatalogDetail.tsx';
import {
  type SkuDetailCopy,
  SkuDetailPageView,
} from '../../catalog/presentation/SkuDetailPage.tsx';
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

const copy: SkuDetailCopy = {
  loadingLabel: 'Loading products',
  errorLabel: 'Load failed',
  retryLabel: 'Try Again',
  notFoundLabel: 'Product not found.',
  backLabel: 'Back to products',
  inquiryLabel: 'Request a Quote',
  oemEyebrow: 'OEM / ODM Programs',
  oemHeading: 'Build This Product for Your Market',
  oemBody: 'Share your requirements with our OEM team.',
  relatedHeading: 'Related Products',
  scalarLabels: { wholesalePrice: 'Wholesale price', unitPrice: 'Unit price' },
  quoteLabel: 'Request a Quote',
  sourcePricingLabels: {
    heading: 'Live source pricing',
    tierQuantityLabel: 'Quantity',
    tierPriceLabel: 'Unit price',
    negotiableLabel: 'Price on request',
    unavailableLabel: 'Pricing unavailable — request a quote',
    moqLabel: 'Source MOQ',
    updatedLabel: 'Updated',
  },
};

const renderView = (state: SkuDetailViewState) =>
  renderToStaticMarkup(
    createElement(SkuDetailView, {
      content,
      state,
      onRetry: () => undefined,
    }),
  );

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (predicate(node)) return node;
  for (const child of Children.toArray(node.props.children as ReactNode)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return undefined;
}

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
  assert.doesNotMatch(loading, /Try Again|Product not found|data-sku-detail|data-catalog-schema/);

  const notFound = renderView({ status: 'not-found' });
  assert.match(notFound, /Product not found/);
  assert.doesNotMatch(notFound, /Try Again|data-sku-detail|data-catalog-schema/);

  const error = renderView({ status: 'error' });
  assert.match(error, /role="alert"/);
  assert.match(error, /Try Again/);
  assert.doesNotMatch(error, /Product not found|data-sku-detail|data-catalog-schema/);
});

test('canonical SKU view keeps exclusive status markup and retry command', () => {
  const loading = renderToStaticMarkup(
    createElement(SkuDetailPageView, { status: 'loading', copy }),
  );
  assert.match(loading, /Loading products/);
  assert.doesNotMatch(loading, /Try Again|Product not found|data-sku-detail/);

  const notFound = renderToStaticMarkup(
    createElement(SkuDetailPageView, { status: 'not-found', copy }),
  );
  assert.match(notFound, /Product not found/);
  assert.doesNotMatch(notFound, /Try Again|data-sku-detail/);

  let retries = 0;
  const errorElement = SkuDetailPageView({
    status: 'error',
    copy,
    onRetry: () => {
      retries += 1;
    },
  });
  const button = findElement(errorElement, (element) => element.type === 'button');
  assert.ok(button);
  assert.equal(typeof button.props.onClick, 'function');
  (button.props.onClick as () => void)();
  assert.equal(retries, 1);
});

test('canonical ready SKU consumes resolved pricing, ordered facts, media, and related links', () => {
  const markup = renderToStaticMarkup(
    createElement(SkuDetailPageView, {
      status: 'ready',
      copy,
      product: {
        _id: 'current',
        name: 'VisionClip',
        slug: 'visionclip',
        productFamily: 'ai-gadgets',
        skuCode: 'AI-100',
        description: 'Compact connected camera.',
      },
      pricing: { source: 'scalar', field: 'wholesalePrice', amount: 15.5, currency: 'USD' },
      facts: [
        { key: 'sku', label: 'SKU', value: 'AI-100' },
        { key: 'moq', label: 'MOQ', value: 100 },
      ],
      breadcrumbs: [
        { label: 'Home', href: '/' },
        { label: 'VisionClip', href: '/products/item/?slug=visionclip' },
      ],
      media: createElement('div', { 'data-media-slot': true }),
      related: [
        {
          _id: 'related',
          name: 'Translator',
          slug: 'translator',
          productFamily: 'ai-gadgets',
        },
      ],
      schema: createElement('script', { 'data-catalog-schema': true }),
    }),
  );
  assert.match(markup, /data-sku-detail="current"/);
  assert.match(markup, /data-media-slot/);
  assert.match(markup, /Wholesale price|\$15\.50/);
  assert.match(markup, /AI-100|MOQ|100/);
  assert.match(markup, /aria-label="Breadcrumb"/);
  assert.match(markup, /<ol[^>]*><li/);
  assert.match(markup, /href="\/"/);
  assert.match(markup, /aria-current="page">VisionClip/);
  assert.match(markup, /href="\/products\/item\/\?slug=translator"/);
  assert.match(markup, /data-catalog-schema/);
});

test('canonical SKU and inline detail render the same result for every pricing decision', () => {
  const cases: Array<[CatalogPricingDecision, string]> = [
    [
      {
        source: 'manual-tiered',
        pricing: {
          schemaVersion: 'manual-catalog-pricing-v1',
          currency: 'USD',
          tiers: [{ minQuantity: 1, unitAmountMinor: 900 }],
        },
      },
      'From $9.00',
    ],
    [{ source: 'scalar', field: 'wholesalePrice', amount: 15.5, currency: 'USD' }, '$15.50'],
    [{ source: 'scalar', field: 'unitPrice', amount: 18.9, currency: 'USD' }, '$18.90'],
    [{ source: 'quote-required' }, 'Request a Quote'],
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'fixed',
          currency: 'USD',
          amountMinor: 250,
          sourceMoq: 100,
        },
      },
      '$2.50',
    ],
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'range',
          currency: 'USD',
          minAmountMinor: 250,
          maxAmountMinor: 499,
        },
      },
      '$4.99',
    ],
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'tiered',
          currency: 'USD',
          tiers: [{ minQuantity: 100, unitAmountMinor: 225 }],
        },
      },
      '$2.25',
    ],
    [
      {
        source: 'alibaba',
        pricing: { source: 'alibaba', state: 'quote', mode: 'negotiable' },
      },
      'Price on request',
    ],
    [
      {
        source: 'alibaba',
        pricing: { source: 'alibaba', state: 'unavailable', mode: 'unavailable' },
      },
      'Pricing unavailable',
    ],
  ];
  for (const [pricing, expected] of cases) {
    const sourceMoq = pricing.source === 'alibaba' ? pricing.pricing.sourceMoq : undefined;
    const media = createElement('div', { 'data-parity-media': true });
    const sku = renderToStaticMarkup(
      createElement(SkuDetailPageView, {
        status: 'ready',
        copy,
        product: { _id: 'same', name: 'Same product' },
        pricing,
        facts: [
          { key: 'shared', label: 'Shared fact', value: 'Shared value' },
          ...(sourceMoq === undefined
            ? []
            : [{ key: 'moq', label: 'MOQ', value: sourceMoq, supplierOwned: true }]),
        ],
        breadcrumbs: [],
        media,
        related: [],
        schema: null,
        sourceUpdated: '2026-08-01T02:00:00.000Z',
      }),
    );
    const inline = renderToStaticMarkup(
      createElement(CatalogDetail, {
        product: { _id: 'same', name: 'Same product' },
        pricing,
        facts: {
          rows: [
            { key: 'shared', label: 'Shared fact', value: 'Shared value' },
            ...(sourceMoq === undefined
              ? []
              : [{ key: 'moq', label: 'MOQ', value: sourceMoq, marker: 'supplier-moq' as const }]),
          ],
          backLabel: 'Back',
          scalarLabels: copy.scalarLabels,
          quoteLabel: copy.quoteLabel,
          inquiryLabel: copy.inquiryLabel,
          sourcePricingLabels: copy.sourcePricingLabels,
          sourceUpdated: '2026-08-01T02:00:00.000Z',
        },
        media,
        onBack: () => undefined,
      }),
    );
    assert.ok(sku.includes(expected), `SKU missing ${expected}`);
    assert.ok(inline.includes(expected), `inline detail missing ${expected}`);
    assert.ok(sku.includes('data-sku-fact="shared"'));
    assert.ok(inline.includes('data-detail-fact="shared"'));
    assert.ok(sku.includes('data-parity-media'));
    assert.ok(inline.includes('data-parity-media'));
    if (pricing.source === 'alibaba') {
      assert.ok(sku.includes('data-alibaba-pricing'));
      assert.ok(inline.includes('data-alibaba-pricing'));
      assert.ok(sku.includes('data-alibaba-updated'));
      assert.ok(inline.includes('data-alibaba-updated'));
    }
    if (sourceMoq !== undefined) {
      assert.ok(sku.includes('data-alibaba-source-moq'));
      assert.ok(inline.includes('data-alibaba-source-moq'));
    }
  }
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
      images: ['/image-1.jpg'],
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
  const schemaSource = markup.match(
    /<script[^>]*data-catalog-schema="true"[^>]*>([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(schemaSource);
  const schema = JSON.parse(schemaSource.replaceAll('&quot;', '"')) as {
    '@graph': Array<Record<string, unknown>>;
  };
  const breadcrumbs = schema['@graph'].find((node) => node['@type'] === 'BreadcrumbList');
  const productSchema = schema['@graph'].find((node) => node['@type'] === 'Product');
  assert.equal((breadcrumbs?.itemListElement as unknown[])?.length, 4);
  assert.equal(productSchema?.name, 'VisionClip');
  assert.equal(productSchema?.sku, 'AI-100');
  assert.equal(Object.hasOwn(productSchema ?? {}, 'aggregateRating'), false);
});

test('invalid manual pricing is absent from both visible detail and Product schema', () => {
  const markup = renderView({
    status: 'ready',
    product: {
      _id: 'invalid-price',
      name: 'Quote only',
      slug: 'quote-only',
      productFamily: 'misc',
      wholesalePrice: -1,
      unitPrice: Number.NaN,
    },
    related: [],
  });

  assert.match(markup, /Request a Quote/);
  assert.doesNotMatch(markup, /\$-1\.00|Wholesale price|Unit price/);
  const schemaSource = markup.match(
    /<script[^>]*data-catalog-schema="true"[^>]*>([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(schemaSource);
  const schema = JSON.parse(schemaSource.replaceAll('&quot;', '"')) as {
    '@graph': Array<Record<string, unknown>>;
  };
  const productSchema = schema['@graph'].find((node) => node['@type'] === 'Product');
  assert.equal(Object.hasOwn(productSchema ?? {}, 'offers'), false);
});
