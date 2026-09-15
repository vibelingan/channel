import type { CatalogContent, CatalogFamilyContent } from '../../i18n/catalog.ts';
import type { CatalogFamilyAdapter } from './catalog-family-adapter.ts';

export function createAiGadgetsAdapter(
  _content: Pick<CatalogContent, 'list' | 'detail'>,
  _family: CatalogFamilyContent,
): CatalogFamilyAdapter {
  throw new Error('AI gadgets adapter not implemented');
}
