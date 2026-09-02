import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import type { ReactElement, ReactNode } from 'react';

export interface SkuDetailProduct {
  _id: string;
  name: string;
  productFamily?: 'headphones' | 'ai-gadgets' | 'toys' | 'misc';
  slug?: string;
  skuCode?: string;
  description?: string;
  images?: string[];
}

export interface SkuDetailFact {
  key: string;
  label: string;
  value: string | number;
  supplierOwned?: boolean;
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
      media: ReactNode;
      related: readonly SkuDetailProduct[];
      schema: ReactNode;
    };

export function SkuDetailPageView(_props: SkuDetailPageViewProps): ReactElement {
  throw new Error('MIU 13 SkuDetailPageView not implemented');
}
