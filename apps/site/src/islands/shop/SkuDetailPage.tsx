import {
  createAlibabaPricingAdapter,
  resolveCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import { useEffect, useState } from 'react';
import {
  type SkuDetailCopy,
  type SkuDetailFact,
  SkuDetailPageView,
} from '../../catalog/presentation/SkuDetailPage.tsx';
import type { CatalogContent } from '../../i18n/catalog.ts';
import {
  catalogBreadcrumbSchema,
  catalogProductSchema,
  hasAddressableProductDetail,
  serializeCatalogSchema,
  skuBreadcrumbs,
} from '../../lib/catalog-seo.ts';
import { DEFAULT_ALIBABA_PRICING_LABELS } from './AlibabaCatalogPricingBlock.tsx';
import { hasUsableCatalogSlug } from './CatalogFamilyGrid.tsx';
import { Gallery } from './Gallery.tsx';
import { fetchProductBySlug, fetchRelatedProducts } from './api.ts';
import type { Product } from './catalog-types.ts';

export type SkuDetailViewState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; product: Product; related: Product[] };

interface ViewProps {
  content: CatalogContent;
  state: SkuDetailViewState;
  onRetry: () => void;
}

interface Props {
  content: CatalogContent;
}

function productFacts(product: Product): SkuDetailFact[] {
  const facts: SkuDetailFact[] = [];
  if (product.skuCode) facts.push({ key: 'sku', label: 'SKU', value: product.skuCode });
  if (product.series) facts.push({ key: 'series', label: 'Series', value: product.series });
  if (product.modName) facts.push({ key: 'model', label: 'Model', value: product.modName });
  if (product.modType) facts.push({ key: 'type', label: 'Type', value: product.modType });
  return facts;
}

function relatedProducts(product: Product, related: Product[]): Array<Product & { slug: string }> {
  if (!product.productFamily) return [];
  return related.filter(
    (candidate): candidate is Product & { slug: string } =>
      candidate._id !== product._id &&
      candidate.productFamily === product.productFamily &&
      hasUsableCatalogSlug(candidate),
  );
}

export function SkuDetailView({ content, state, onRetry }: ViewProps) {
  const { detail, list } = content;
  const copy: SkuDetailCopy = {
    loadingLabel: list.loadingLabel,
    errorLabel: list.errorLabel,
    retryLabel: list.retryLabel,
    notFoundLabel: detail.notFound,
    backLabel: detail.backLabel,
    inquiryLabel: detail.inquiryCta,
    oemEyebrow: detail.oemEyebrow,
    oemHeading: detail.oemHeading,
    oemBody: detail.oemBody,
    relatedHeading: detail.relatedHeading,
    scalarLabels: {
      wholesalePrice: detail.wholesaleLabel,
      unitPrice: detail.unitPriceLabel,
    },
    quoteLabel: detail.inquiryCta,
    sourcePricingLabels: DEFAULT_ALIBABA_PRICING_LABELS,
  };
  if (state.status === 'loading') {
    return <SkuDetailPageView status="loading" copy={copy} />;
  }

  if (state.status === 'not-found') {
    return <SkuDetailPageView status="not-found" copy={copy} />;
  }

  if (state.status === 'error') {
    return <SkuDetailPageView status="error" copy={copy} onRetry={onRetry} />;
  }

  const { product } = state;
  const facts = productFacts(product);
  const related = relatedProducts(product, state.related);
  const { alibabaPrimarySourceKey, ...unlinkedProduct } = product;
  const pricing = resolveCatalogPricing(
    alibabaPrimarySourceKey == null ? unlinkedProduct : product,
    createAlibabaPricingAdapter(),
  );
  const moq = pricing.source === 'alibaba' ? pricing.pricing.sourceMoq : product.moq;
  if (moq !== undefined) {
    facts.push({
      key: 'moq',
      label: list.moqLabel,
      value: moq,
      ...(pricing.source === 'alibaba' ? { supplierOwned: true } : {}),
    });
  }
  const breadcrumbs = skuBreadcrumbs(product);
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  // The public slug endpoint admits only published, non-archived products.
  const productSchema = catalogProductSchema(product, origin, { published: true });
  const schemaNodes = [
    ...(breadcrumbs.length > 0 ? [catalogBreadcrumbSchema(breadcrumbs, origin)] : []),
    ...(productSchema ? [productSchema] : []),
  ];

  const schema =
    schemaNodes.length > 0 ? (
      <script
        type="application/ld+json"
        data-catalog-schema
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serializer escapes `<` so remote text cannot terminate the script.
        dangerouslySetInnerHTML={{ __html: serializeCatalogSchema(schemaNodes) }}
      />
    ) : null;
  return (
    <SkuDetailPageView
      status="ready"
      copy={copy}
      product={product}
      pricing={pricing}
      facts={facts}
      breadcrumbs={breadcrumbs}
      media={
        <Gallery
          images={product.images ?? []}
          alt={product.name}
          productId={product._id}
          unavailableLabel="Product image unavailable"
        />
      }
      related={related}
      schema={schema}
      sourceUpdated={product.alibabaCatalogPricing?.sourceUpdatedAt}
    />
  );
}

export function SkuDetailPage({ content }: Props) {
  const [state, setState] = useState<SkuDetailViewState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry token intentionally starts a fresh request.
  useEffect(() => {
    const controller = new AbortController();
    const slug = new URLSearchParams(window.location.search).get('slug')?.trim() ?? '';
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = new URL('/products/item/', window.location.origin).href;
    if (!slug) {
      setState({ status: 'not-found' });
      return () => controller.abort();
    }
    setState({ status: 'loading' });
    fetchProductBySlug(slug, controller.signal)
      .then((product) => {
        if (controller.signal.aborted) return;
        if (canonical && hasAddressableProductDetail(product)) {
          canonical.href = new URL(
            `/products/item/?slug=${encodeURIComponent(product.slug.trim())}`,
            window.location.origin,
          ).href;
        }
        setState({ status: 'ready', product, related: [] });
        fetchRelatedProducts(product, 4, controller.signal)
          .then((related) => {
            if (controller.signal.aborted) return;
            setState((current) =>
              current.status === 'ready' && current.product._id === product._id
                ? { ...current, related }
                : current,
            );
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            console.error('[sku-detail] related products failed', error);
          });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: error instanceof Error && error.message === 'not-found' ? 'not-found' : 'error',
        });
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <SkuDetailView
      content={content}
      state={state}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}
