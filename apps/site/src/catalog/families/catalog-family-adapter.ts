import type { PublicProduct } from '@vibelingan-channel/shared/catalog';

type ProductFamily = PublicProduct['productFamily'];

export interface CatalogFamilyFilterCapability {
  key: string;
  label: string;
}

export interface CatalogFamilyFact {
  key: string;
  label: string;
  value: string | number;
}

export interface CatalogFamilyAdapter {
  family: ProductFamily;
  labels: Readonly<Record<string, string>>;
  filterCapabilities: readonly CatalogFamilyFilterCapability[];
  group(product: PublicProduct): string | null;
  facts(product: PublicProduct): readonly CatalogFamilyFact[];
  emptyCopy: string;
}

export function assertCatalogFamilyAdapter(
  _adapter: unknown,
): asserts _adapter is CatalogFamilyAdapter {
  throw new Error('MIU 15 CatalogFamilyAdapter guard not implemented');
}
