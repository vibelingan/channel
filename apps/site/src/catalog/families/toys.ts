import {
  type CatalogAdapterContent,
  type CatalogFamilyContent,
  getCatalogContent,
  getCatalogFamily,
} from '../../i18n/catalog.ts';
import {
  type CatalogFamilyAdapter,
  type CatalogFamilyFact,
  assertCatalogFamilyAdapter,
} from './catalog-family-adapter.ts';

export function createToysAdapter(
  content: CatalogAdapterContent,
  family: CatalogFamilyContent,
): CatalogFamilyAdapter {
  if (family.key !== 'toys') throw new TypeError('Expected toys content');
  const detail = {
    ...content.detail,
    productCodeLabel: content.detail.productCodeLabel ?? 'Product Code',
  };
  const adapter: CatalogFamilyAdapter = {
    family: 'toys',
    labels: {
      ...content.list,
      label: family.label,
      href: family.href,
      eyebrow: family.eyebrow,
      heading: family.heading,
      description: family.description,
      seoTitle: family.seoTitle,
      seoDescription: family.seoDescription,
      ...Object.fromEntries(Object.entries(detail).map(([key, value]) => [`detail.${key}`, value])),
    },
    filterCapabilities: [],
    group() {
      return null;
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
    emptyCopy: content.list.emptyLabel,
  };
  assertCatalogFamilyAdapter(adapter);
  return adapter;
}

export const toysAdapter: CatalogFamilyAdapter = createToysAdapter(
  getCatalogContent(),
  getCatalogFamily('toys'),
);

export function selectToysAdapter(pathname: string): CatalogFamilyAdapter | null {
  switch (pathname) {
    case '/toys':
    case '/toys/':
    case '/electronics-toys':
    case '/electronics-toys/':
      return toysAdapter;
    default:
      return null;
  }
}
