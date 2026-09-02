import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Children, type ReactElement, type ReactNode, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
  assert.match(markup, /href="\/products\/item\/\?slug=translator"/);
  assert.match(markup, /data-catalog-schema/);
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
