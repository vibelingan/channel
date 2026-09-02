import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import type { ReactElement, ReactNode } from 'react';
import { QuantityTierPricingBlock } from '../../islands/shop/QuantityTierPricingBlock.tsx';
import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts';

export interface CatalogDetailProduct {
  _id: string;
  name: string;
  modName?: string;
  description?: string;
}

export interface CatalogDetailFact {
  key: string;
  label: string;
  value: string | number;
  marker?: 'supplier-moq';
}

export interface CatalogDetailFacts {
  categoryLabel?: string;
  rows: readonly CatalogDetailFact[];
  backLabel: string;
  scalarLabels: Record<'wholesalePrice' | 'unitPrice', string>;
  quoteLabel: string;
  inquiryLabel: string;
  sourcePricingLabels: {
    heading: string;
    tierQuantityLabel: string;
    tierPriceLabel: string;
    negotiableLabel: string;
    unavailableLabel: string;
    moqLabel: string;
    updatedLabel: string;
  };
  sourceUpdated?: string;
}

export interface CatalogDetailProps {
  product: CatalogDetailProduct;
  pricing: CatalogPricingDecision;
  facts: CatalogDetailFacts;
  media: ReactNode;
  onBack: () => void;
}

type AlibabaDecision = Extract<CatalogPricingDecision, { source: 'alibaba' }>['pricing'];

function formatMinorAmount(amountMinor: number, currency: 'CNY' | 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function formatMajorAmount(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

function AlibabaDecisionPricing({
  pricing,
  labels,
  sourceUpdated,
}: {
  pricing: AlibabaDecision;
  labels: CatalogDetailFacts['sourcePricingLabels'];
  sourceUpdated?: string;
}): ReactElement {
  let content: ReactNode;
  switch (pricing.mode) {
    case 'fixed':
      content = (
        <p className="font-display text-3xl font-bold text-brand-700" data-alibaba-amount>
          {formatMinorAmount(pricing.amountMinor, pricing.currency)}
        </p>
      );
      break;
    case 'range':
      content = (
        <p className="font-display text-3xl font-bold text-brand-700" data-alibaba-amount>
          {formatMinorAmount(pricing.minAmountMinor, pricing.currency)}
          <span className="px-1 text-ink-muted">–</span>
          {formatMinorAmount(pricing.maxAmountMinor, pricing.currency)}
        </p>
      );
      break;
    case 'tiered':
      content = (
        <table className="w-full text-sm" data-alibaba-tiers>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
              <th className="py-1 pr-4 font-medium">{labels.tierQuantityLabel}</th>
              <th className="py-1 font-medium">{labels.tierPriceLabel}</th>
            </tr>
          </thead>
          <tbody>
            {pricing.tiers.map((tier) => (
              <tr key={tier.minQuantity} className="border-t border-slate-100">
                <td className="py-1.5 pr-4 text-ink-soft">
                  {tier.maxQuantity !== undefined
                    ? `${tier.minQuantity} – ${tier.maxQuantity}`
                    : `${tier.minQuantity}+`}
                </td>
                <td className="py-1.5 font-semibold text-brand-700">
                  {formatMinorAmount(tier.unitAmountMinor, pricing.currency)}
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
          {labels.negotiableLabel}
        </p>
      );
      break;
    case 'unavailable':
      content = (
        <p className="text-sm font-medium text-ink-soft" data-alibaba-unavailable>
          {labels.unavailableLabel}
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
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{labels.heading}</p>
      <div className="mt-2">{content}</div>
      {pricing.sourceMoq !== undefined || sourceUpdated !== undefined ? (
        <p className="mt-2 text-xs text-ink-muted">
          {pricing.sourceMoq !== undefined ? (
            <span data-alibaba-moq>
              {labels.moqLabel}: <strong>{pricing.sourceMoq}</strong>
            </span>
          ) : null}
          {pricing.sourceMoq !== undefined && sourceUpdated !== undefined ? (
            <span className="px-1" aria-hidden="true">
              ·
            </span>
          ) : null}
          {sourceUpdated !== undefined ? (
            <span data-alibaba-updated>
              {labels.updatedLabel}: {sourceUpdated.slice(0, 10)}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function pricingContent(pricing: CatalogPricingDecision, facts: CatalogDetailFacts): ReactNode {
  switch (pricing.source) {
    case 'alibaba':
      return (
        <AlibabaDecisionPricing
          pricing={pricing.pricing}
          labels={facts.sourcePricingLabels}
          sourceUpdated={facts.sourceUpdated}
        />
      );
    case 'manual-tiered':
      return <QuantityTierPricingBlock pricing={pricing.pricing} />;
    case 'scalar':
      return (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            {facts.scalarLabels[pricing.field]}
          </p>
          <p className="mt-2 font-display text-3xl font-bold text-brand-700">
            {formatMajorAmount(pricing.amount)}
          </p>
        </div>
      );
    case 'quote-required':
      return (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            {facts.quoteLabel}
          </p>
          <p className="mt-2 font-display text-3xl font-bold text-brand-700">{facts.quoteLabel}</p>
        </div>
      );
    default: {
      const exhaustive: never = pricing;
      return exhaustive;
    }
  }
}

export function CatalogDetail({
  product,
  pricing,
  facts,
  media,
  onBack,
}: CatalogDetailProps): ReactElement {
  return (
    <section
      data-product-detail={product._id}
      className="border-t border-slate-200 bg-surface-alt py-16 sm:py-20"
    >
      <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          data-detail-back
          onClick={onBack}
          className="mb-8 inline-flex items-center gap-2 rounded text-sm font-medium text-ink-soft transition hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {facts.backLabel}
        </button>

        <div className="grid gap-10 lg:grid-cols-2">
          <div data-detail-media-column className="min-w-0">
            {media}
          </div>

          <div data-detail-info-column className="min-w-0">
            {facts.categoryLabel ? (
              <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                {facts.categoryLabel}
              </span>
            ) : null}
            <h2
              tabIndex={-1}
              data-detail-heading
              className="mt-3 break-words font-display text-3xl font-bold text-ink outline-none"
            >
              {product.name}
            </h2>
            {product.modName ? (
              <p className="mt-1 text-sm font-medium uppercase tracking-wide text-ink-muted">
                {product.modName}
              </p>
            ) : null}
            {product.description ? (
              <p className="mt-4 break-words text-base leading-relaxed text-ink-soft">
                {product.description}
              </p>
            ) : null}

            <dl className="mt-6 divide-y divide-slate-100 rounded-[var(--radius-card)] border border-slate-200 bg-white">
              {facts.rows.map((fact) => (
                <div
                  key={fact.key}
                  data-detail-fact={fact.key}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <dt className="text-sm text-ink-muted">{fact.label}</dt>
                  <dd
                    {...(fact.marker === 'supplier-moq' ? { 'data-alibaba-source-moq': true } : {})}
                    className="min-w-0 break-words text-right text-sm font-semibold text-ink"
                  >
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="mt-6 rounded-[var(--radius-card)] bg-white p-5 shadow-sm ring-1 ring-slate-200">
              {pricingContent(pricing, facts)}
            </div>

            <div className="mt-6">
              <a
                href={OEM_INQUIRY_HREF}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-6 py-3.5 text-base font-semibold text-brand-950 shadow-sm transition hover:bg-accent-400 sm:w-auto"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 8l9 6 9-6M5 19h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z"
                  />
                </svg>
                {facts.inquiryLabel}
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
