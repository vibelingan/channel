import { type HeadphonesFamilyContent, getHeadphonesContent } from '../../i18n/headphones.ts';
import {
  type CatalogFamilyAdapter,
  type CatalogFamilyFact,
  assertCatalogFamilyAdapter,
} from './catalog-family-adapter.ts';

export function createHeadphonesAdapter(content: HeadphonesFamilyContent): CatalogFamilyAdapter {
  const { categories, ...listLabels } = content.list;
  const detail = {
    ...content.detail,
    productCodeLabel: content.detail.productCodeLabel ?? 'Product Code',
  };
  const filters = categories.map(({ key, label }) => ({ key, label }));
  const adapter: CatalogFamilyAdapter = {
    family: 'headphones',
    labels: {
      ...listLabels,
      ...Object.fromEntries(Object.entries(detail).map(([key, label]) => [`detail.${key}`, label])),
    },
    filterCapabilities: filters,
    group(product) {
      return product.category || 'uncategorized';
    },
    facts(product) {
      const facts: CatalogFamilyFact[] = [];
      if (product.series)
        facts.push({ key: 'series', label: detail.seriesLabel, value: product.series });
      if (product.modName)
        facts.push({ key: 'model', label: detail.modelLabel, value: product.modName });
      if (product.modType)
        facts.push({ key: 'type', label: detail.typeLabel, value: product.modType });
      if (product.productCode)
        facts.push({
          key: 'product-code',
          label: detail.productCodeLabel,
          value: product.productCode,
        });
      return facts;
    },
    emptyCopy: content.list.emptyStateLabel,
  };
  assertCatalogFamilyAdapter(adapter);
  return adapter;
}

export const headphonesAdapter: CatalogFamilyAdapter = createHeadphonesAdapter(
  getHeadphonesContent(),
);
