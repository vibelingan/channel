import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import type { ReactElement } from 'react';

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

export function CatalogCard(_props: CatalogCardProps): ReactElement {
  throw new Error('MIU 10 CatalogCard not implemented');
}
