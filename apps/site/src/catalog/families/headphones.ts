import type { HeadphonesContent } from '../../i18n/headphones.ts';
import type { CatalogFamilyAdapter } from './catalog-family-adapter.ts';

export function createHeadphonesAdapter(_content: HeadphonesContent): CatalogFamilyAdapter {
  throw new Error('Headphones adapter not implemented');
}
