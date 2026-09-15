import type { CatalogAdapterContent, CatalogFamilyContent } from '../../i18n/catalog.ts';
import type { CatalogFamilyAdapter } from './catalog-family-adapter.ts';

export function createToysAdapter(
  _content: CatalogAdapterContent,
  _family: CatalogFamilyContent,
): CatalogFamilyAdapter {
  throw new Error('Toys adapter not implemented');
}

export function selectToysAdapter(_pathname: string): CatalogFamilyAdapter | null {
  throw new Error('Toys route selection not implemented');
}
