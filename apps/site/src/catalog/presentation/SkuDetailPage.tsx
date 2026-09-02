import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import type { ReactElement, ReactNode } from 'react';
import { ProductMedia } from '../../islands/shop/ProductMedia.tsx';
import { QuantityTierPricingBlock } from '../../islands/shop/QuantityTierPricingBlock.tsx';
import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts';

export interface SkuDetailProduct {
  _id: string;
  name: string;
  productFamily?: 'headphones' | 'ai-gadgets' | 'toys' | 'misc';
  slug?: string;
  skuCode?: string;
  description?: string;
  images?: string[];
}

export interface SkuRelatedProduct extends SkuDetailProduct {
  slug: string;
}

export interface SkuDetailFact {
  key: string;
  label: string;
  value: string | number;
  supplierOwned?: boolean;
}

export interface SkuDetailBreadcrumb {
  label: string;
  href: string;
}

export interface SkuDetailCopy {
  loadingLabel: string;
  errorLabel: string;
  retryLabel: string;
  notFoundLabel: string;
  backLabel: string;
  inquiryLabel: string;
  oemEyebrow: string;
  oemHeading: string;
  oemBody: string;
  relatedHeading: string;
  scalarLabels: Record<'wholesalePrice' | 'unitPrice', string>;
  quoteLabel: string;
  sourcePricingLabels: {
    heading: string;
    tierQuantityLabel: string;
    tierPriceLabel: string;
    negotiableLabel: string;
    unavailableLabel: string;
    moqLabel: string;
    updatedLabel: string;
  };
}

export type SkuDetailPageViewProps =
  | { status: 'loading'; copy: SkuDetailCopy }
  | { status: 'not-found'; copy: SkuDetailCopy }
  | { status: 'error'; copy: SkuDetailCopy; onRetry: () => void }
  | {
      status: 'ready';
      copy: SkuDetailCopy;
      product: SkuDetailProduct;
      pricing: CatalogPricingDecision;
      facts: readonly SkuDetailFact[];
      breadcrumbs: readonly SkuDetailBreadcrumb[];
      media: ReactNode;
      related: readonly SkuRelatedProduct[];
      schema: ReactNode;
      sourceUpdated?: string;
    };

type AlibabaDecision = Extract<CatalogPricingDecision, { source: 'alibaba' }>['pricing'];

function formatMinor(amountMinor: number, currency: 'CNY' | 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function formatMajor(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

function AlibabaSkuPricing({
  pricing,
  copy,
  sourceUpdated,
}: {
  pricing: AlibabaDecision;
  copy: SkuDetailCopy;
  sourceUpdated?: string;
}): ReactElement {
  let content: ReactNode;
  switch (pricing.mode) {
    case 'fixed':
      content = (
        <p className="font-display text-3xl font-bold text-brand-700" data-alibaba-amount>
          {formatMinor(pricing.amountMinor, pricing.currency)}
        </p>
      );
      break;
    case 'range':
      content = (
        <p className="font-display text-3xl font-bold text-brand-700" data-alibaba-amount>
          {formatMinor(pricing.minAmountMinor, pricing.currency)}
          <span className="px-1 text-ink-muted">–</span>
          {formatMinor(pricing.maxAmountMinor, pricing.currency)}
        </p>
      );
      break;
    case 'tiered':
      content = (
        <table className="w-full text-sm" data-alibaba-tiers>
          <thead>
            <tr className="text-left text-xs uppercase text-ink-muted">
              <th className="py-1 pr-4 font-medium">
                {copy.sourcePricingLabels.tierQuantityLabel}
              </th>
              <th className="py-1 font-medium">{copy.sourcePricingLabels.tierPriceLabel}</th>
            </tr>
          </thead>
          <tbody>
            {pricing.tiers.map((tier) => (
              <tr key={tier.minQuantity} className="border-t border-slate-100">
                <td className="py-1.5 pr-4 text-ink-soft">
                  {tier.maxQuantity === undefined
                    ? `${tier.minQuantity}+`
                    : `${tier.minQuantity} – ${tier.maxQuantity}`}
                </td>
                <td className="py-1.5 font-semibold text-brand-700">
                  {formatMinor(tier.unitAmountMinor, pricing.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
      break;
    case 'negotiable':
      content = (
        <p className="text-sm font-medium text-ink-soft" data-alibaba-negotiable>
          {copy.sourcePricingLabels.negotiableLabel}
        </p>
      );
      break;
    case 'unavailable':
      content = (
        <p className="text-sm font-medium text-ink-soft" data-alibaba-unavailable>
          {copy.sourcePricingLabels.unavailableLabel}
        </p>
      );
      break;
    default: {
      const exhaustive: never = pricing;
      return exhaustive;
    }
  }
  return (
    <div data-alibaba-pricing data-mode={pricing.mode}>
      <p className="text-xs font-medium uppercase text-ink-muted">
        {copy.sourcePricingLabels.heading}
      </p>
      <div className="mt-2">{content}</div>
      {pricing.sourceMoq !== undefined || sourceUpdated !== undefined ? (
        <p className="mt-2 text-xs text-ink-muted">
          {pricing.sourceMoq !== undefined ? (
            <span data-alibaba-moq>
              {copy.sourcePricingLabels.moqLabel}: <strong>{pricing.sourceMoq}</strong>
            </span>
          ) : null}
          {pricing.sourceMoq !== undefined && sourceUpdated !== undefined ? (
            <span className="px-1" aria-hidden="true">
              ·
            </span>
          ) : null}
          {sourceUpdated !== undefined ? (
            <span data-alibaba-updated>
              {copy.sourcePricingLabels.updatedLabel}: {sourceUpdated.slice(0, 10)}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function Pricing({
  pricing,
  copy,
  sourceUpdated,
}: {
  pricing: CatalogPricingDecision;
  copy: SkuDetailCopy;
  sourceUpdated?: string;
}): ReactNode {
  switch (pricing.source) {
    case 'alibaba':
      return (
        <AlibabaSkuPricing pricing={pricing.pricing} copy={copy} sourceUpdated={sourceUpdated} />
      );
    case 'manual-tiered':
      return <QuantityTierPricingBlock pricing={pricing.pricing} />;
    case 'scalar':
      return (
        <div>
          <p className="text-xs font-medium uppercase text-ink-muted">
            {copy.scalarLabels[pricing.field]}
          </p>
          <p className="mt-2 font-display text-2xl font-bold text-brand-700">
            {formatMajor(pricing.amount)}
          </p>
        </div>
      );
    case 'quote-required':
      return <p className="font-display text-2xl font-bold text-brand-700">{copy.quoteLabel}</p>;
    default: {
      const exhaustive: never = pricing;
      return exhaustive;
    }
  }
}

export function SkuDetailPageView(props: SkuDetailPageViewProps): ReactElement {
  if (props.status === 'loading') {
    return (
      <div className="mx-auto max-w-[var(--width-container)] px-4 py-20 sm:px-6 lg:px-8">
        <h1 className="sr-only">Product details</h1>
        <p className="text-center text-ink-muted" aria-live="polite">
          {props.copy.loadingLabel}
        </p>
      </div>
    );
  }
  if (props.status === 'not-found') {
    return (
      <div className="mx-auto max-w-[var(--width-container)] px-4 py-20 text-center sm:px-6 lg:px-8">
        <h1 className="font-display text-3xl font-bold text-ink">{props.copy.notFoundLabel}</h1>
        <a
          href="/electronics-toys/"
          className="mt-6 inline-flex min-h-11 items-center font-semibold text-brand-700 underline"
        >
          {props.copy.backLabel}
        </a>
      </div>
    );
  }
  if (props.status === 'error') {
    return (
      <div
        role="alert"
        className="mx-auto my-20 max-w-2xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-800"
      >
        <h1 className="font-display text-2xl font-bold text-red-900">
          Product details unavailable
        </h1>
        <p>{props.copy.errorLabel}</p>
        <button
          type="button"
          onClick={props.onRetry}
          className="mt-4 min-h-11 border border-red-300 bg-white px-4 py-2 font-semibold"
        >
          {props.copy.retryLabel}
        </button>
      </div>
    );
  }

  return (
    <>
      <section data-sku-detail={props.product._id} className="bg-white py-12 sm:py-16">
        <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
          <nav aria-label="Breadcrumb" className="mb-8 text-sm text-ink-muted">
            <ol className="flex flex-wrap items-center">
              {props.breadcrumbs.map((breadcrumb, index) => (
                <li key={breadcrumb.href} className="flex items-center">
                  {index < props.breadcrumbs.length - 1 ? (
                    <>
                      <a href={breadcrumb.href} className="hover:text-brand-700">
                        {breadcrumb.label}
                      </a>
                      <span className="px-2" aria-hidden="true">
                        /
                      </span>
                    </>
                  ) : (
                    <span aria-current="page">{breadcrumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <div className="grid min-w-0 gap-10 lg:grid-cols-2">
            <div className="min-w-0">{props.media}</div>
            <div className="min-w-0">
              <h1 className="break-words font-display text-4xl font-bold text-ink">
                {props.product.name}
              </h1>
              {props.product.description ? (
                <p className="mt-5 break-words text-lg leading-relaxed text-ink-soft">
                  {props.product.description}
                </p>
              ) : null}
              {props.facts.length > 0 ? (
                <dl className="mt-8 divide-y divide-slate-100 border border-slate-200 bg-white">
                  {props.facts.map((fact) => (
                    <div
                      key={fact.key}
                      data-sku-fact={fact.key}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <dt className="text-sm text-ink-muted">{fact.label}</dt>
                      <dd
                        {...(fact.supplierOwned ? { 'data-alibaba-source-moq': true } : {})}
                        className="min-w-0 break-words text-right text-sm font-semibold text-ink"
                      >
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <div className="mt-8 border-y border-slate-200 py-5">
                <Pricing
                  pricing={props.pricing}
                  copy={props.copy}
                  sourceUpdated={props.sourceUpdated}
                />
              </div>
              <div className="mt-8 border-l-4 border-brand-600 bg-surface-alt px-5 py-5">
                <p className="text-xs font-semibold uppercase text-brand-600">
                  {props.copy.oemEyebrow}
                </p>
                <h2 className="mt-2 font-display text-xl font-bold text-ink">
                  {props.copy.oemHeading}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{props.copy.oemBody}</p>
                <a
                  href={OEM_INQUIRY_HREF}
                  className="mt-5 inline-flex min-h-11 items-center justify-center bg-accent-500 px-6 py-3 font-semibold text-brand-950 hover:bg-accent-400"
                >
                  {props.copy.inquiryLabel}
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>
      {props.related.length > 0 ? (
        <section
          className="border-t border-slate-200 bg-surface-alt py-12"
          aria-labelledby="related-products-heading"
        >
          <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
            <h2 id="related-products-heading" className="font-display text-2xl font-bold text-ink">
              {props.copy.relatedHeading}
            </h2>
            <div className="mt-6 grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
              {props.related.map((candidate) => (
                <a
                  key={candidate._id}
                  href={`/products/item/?slug=${encodeURIComponent(candidate.slug.trim())}`}
                  className="group min-w-0 bg-white p-4 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-brand-700"
                >
                  <div className="aspect-square overflow-hidden bg-white">
                    <ProductMedia
                      sources={candidate.images ?? []}
                      alt={candidate.name}
                      imageClassName="p-4"
                    />
                  </div>
                  <h3 className="mt-3 font-display text-base font-semibold text-ink group-hover:text-brand-700">
                    {candidate.name}
                  </h3>
                </a>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      {props.schema}
    </>
  );
}
