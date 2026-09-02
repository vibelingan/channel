import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import type { ReactElement } from 'react';

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
}

export interface CatalogDetailMedia {
  images: readonly string[];
  viewAllLabel: string;
  showLessLabel: string;
  unavailableLabel: string;
}

export interface CatalogDetailProps {
  product: CatalogDetailProduct;
  pricing: CatalogPricingDecision;
  facts: CatalogDetailFacts;
  media: CatalogDetailMedia;
  onBack: () => void;
}

export function CatalogDetail(_props: CatalogDetailProps): ReactElement {
  throw new Error('MIU 11 CatalogDetail not implemented');
}
