import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import type { ReactElement, ReactNode } from 'react';
import { ProductMedia } from '../../islands/shop/ProductMedia.tsx';

export interface CatalogCardProduct {
  _id: string;
  name: string;
  modName?: string;
  description?: string;
  images?: string[];
}

export interface CatalogCardFacts {
  identifier?: string;
  moq?: number;
  moqLabel: string;
  unavailableLabel: string;
  actionLabel: string;
  imageUnavailableLabel: string;
}

export interface CatalogCardProps {
  product: CatalogCardProduct;
  pricing: CatalogPricingDecision;
  facts: CatalogCardFacts;
  onActivate: (productId: string) => void;
  deepLink?: string;
}

function formatMinor(amount: number, currency: 'CNY' | 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount / 100);
}

function formatMajor(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

function priceLabel(pricing: CatalogPricingDecision, unavailableLabel: string): string {
  switch (pricing.source) {
    case 'alibaba': {
      if (pricing.pricing.state !== 'available') return unavailableLabel;
      switch (pricing.pricing.mode) {
        case 'fixed':
          return formatMinor(pricing.pricing.amountMinor, pricing.pricing.currency);
        case 'range':
          return `${formatMinor(pricing.pricing.minAmountMinor, pricing.pricing.currency)} – ${formatMinor(pricing.pricing.maxAmountMinor, pricing.pricing.currency)}`;
        case 'tiered':
          return `From ${formatMinor(Math.min(...pricing.pricing.tiers.map((tier) => tier.unitAmountMinor)), pricing.pricing.currency)}`;
        default: {
          const exhaustive: never = pricing.pricing;
          return exhaustive;
        }
      }
    }
    case 'manual-tiered':
      return `From ${formatMinor(Math.min(...pricing.pricing.tiers.map((tier) => tier.unitAmountMinor)), pricing.pricing.currency)}`;
    case 'scalar':
      return formatMajor(pricing.amount);
    case 'quote-required':
      return unavailableLabel;
    default: {
      const exhaustive: never = pricing;
      return exhaustive;
    }
  }
}

export function CatalogCard({
  product,
  pricing,
  facts,
  onActivate,
  deepLink,
}: CatalogCardProps): ReactElement {
  const isAlibaba = pricing.source === 'alibaba';
  const unavailable = isAlibaba && pricing.pricing.state !== 'available';
  const content: ReactNode = (
    <>
      <div className="relative aspect-square overflow-hidden bg-white">
        <ProductMedia
          sources={product.images ?? []}
          alt={product.name}
          unavailableLabel={facts.imageUnavailableLabel}
          loading="lazy"
          fetchPriority="low"
          imageClassName="p-6 transition duration-300 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />
      </div>
      <div className="flex flex-1 flex-col border-t border-slate-100 p-4">
        <h4 className="font-display text-base font-semibold text-ink group-hover:text-brand-700">
          {product.name}
        </h4>
        {facts.identifier ? (
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
            {facts.identifier}
          </p>
        ) : null}
        {product.description ? (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-ink-soft">
            {product.description}
          </p>
        ) : null}
        <div className="mt-auto pt-4">
          <div className="flex items-center justify-between text-xs text-ink-muted">
            {facts.moq !== undefined ? (
              <span {...(isAlibaba ? { 'data-alibaba-card-moq': true } : {})}>
                {facts.moqLabel}: <strong>{facts.moq}</strong>
              </span>
            ) : null}
            <span
              {...(isAlibaba
                ? unavailable
                  ? { 'data-alibaba-card-unavailable': true }
                  : { 'data-alibaba-card-price': true }
                : { 'data-product-card-price': true })}
              data-catalog-card-price
              className={`text-sm ${unavailable ? 'font-medium text-ink-soft' : 'font-semibold text-brand-700'}`}
            >
              {priceLabel(pricing, facts.unavailableLabel)}
            </span>
          </div>
          <div
            data-product-card-action
            data-catalog-card-action
            className="mt-3 flex items-center gap-1.5 text-xs font-medium text-brand-600 transition group-hover:text-brand-700"
          >
            {facts.actionLabel}
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </div>
      </div>
    </>
  );
  const className =
    'group relative flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-[var(--shadow-card)] motion-reduce:transition-none motion-reduce:hover:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2';
  const activate = () => onActivate(product._id);
  return deepLink ? (
    <a href={deepLink} data-product-card={product._id} onClick={activate} className={className}>
      {content}
    </a>
  ) : (
    <button type="button" data-product-card={product._id} onClick={activate} className={className}>
      {content}
    </button>
  );
}
