import { type ProductFamily, isProductFamily } from '@vibelingan-channel/shared';
import { publicManualPrice, validMinorAmount } from '../islands/shop/catalog-pricing.ts';
import type { Product } from '../islands/shop/catalog-types.ts';

export interface CatalogBreadcrumb {
  label: string;
  href: string;
}

export type CatalogSchemaNode = Record<string, unknown>;

const FAMILY_LABELS: Record<ProductFamily, string> = {
  headphones: 'Headphones',
  'ai-gadgets': 'AI Gadgets',
  toys: 'Toys',
  misc: 'Other Electronics & Toys',
};

const FAMILY_PATHS: Record<ProductFamily, string> = {
  headphones: '/headphones/',
  'ai-gadgets': '/ai-gadgets/',
  toys: '/toys/',
  misc: '/misc/',
};

function absoluteUrl(path: string, origin: string | URL): string {
  return new URL(path, origin).href;
}

export function familyBreadcrumbs(label: string, href: string): CatalogBreadcrumb[] {
  return [...hubBreadcrumbs(), { label, href }];
}

export function hubBreadcrumbs(): CatalogBreadcrumb[] {
  return [
    { label: 'Home', href: '/' },
    { label: 'Electronics & Toys', href: '/electronics-toys/' },
  ];
}

export function skuBreadcrumbs(product: Product): CatalogBreadcrumb[] {
  if (!isProductFamily(product.productFamily) || !product.slug?.trim() || !product.name.trim()) {
    return [];
  }
  const slug = product.slug.trim();
  return [
    ...familyBreadcrumbs(FAMILY_LABELS[product.productFamily], FAMILY_PATHS[product.productFamily]),
    { label: product.name, href: `/products/item/?slug=${encodeURIComponent(slug)}` },
  ];
}

export function hasAddressableProductDetail(product: Product): product is Product & {
  productFamily: ProductFamily;
  slug: string;
  description: string;
  images: string[];
} {
  return Boolean(
    isProductFamily(product.productFamily) &&
      product.name.trim() &&
      product.slug?.trim() &&
      product.description?.trim() &&
      product.images?.some(Boolean),
  );
}

export function catalogBreadcrumbSchema(
  breadcrumbs: readonly CatalogBreadcrumb[],
  origin: string | URL,
): CatalogSchemaNode {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((breadcrumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: breadcrumb.label,
      item: absoluteUrl(breadcrumb.href, origin),
    })),
  };
}

function realOffer(product: Product, origin: string | URL): CatalogSchemaNode | null {
  const url = absoluteUrl(
    `/products/item/?slug=${encodeURIComponent(product.slug?.trim() ?? '')}`,
    origin,
  );
  if (product.alibabaPrimarySourceKey) {
    const pricing = product.alibabaCatalogPricing;
    if (!pricing?.currency) return null;
    if (pricing.mode === 'range') {
      if (
        !validMinorAmount(pricing.minAmountMinor) ||
        !validMinorAmount(pricing.maxAmountMinor) ||
        pricing.maxAmountMinor < pricing.minAmountMinor
      ) {
        return null;
      }
      return {
        '@type': 'AggregateOffer',
        priceCurrency: pricing.currency,
        lowPrice: (pricing.minAmountMinor / 100).toFixed(2),
        highPrice: (pricing.maxAmountMinor / 100).toFixed(2),
        url,
      };
    }
    if (pricing.mode !== 'fixed' || !validMinorAmount(pricing.amountMinor)) return null;
    return {
      '@type': 'Offer',
      priceCurrency: pricing.currency,
      price: (pricing.amountMinor / 100).toFixed(2),
      url,
    };
  }
  if (product.manualCatalogPricing) {
    const amounts = product.manualCatalogPricing.tiers.map((tier) => tier.unitAmountMinor);
    return {
      '@type': 'AggregateOffer',
      priceCurrency: product.manualCatalogPricing.currency,
      lowPrice: (Math.min(...amounts) / 100).toFixed(2),
      highPrice: (Math.max(...amounts) / 100).toFixed(2),
      url,
    };
  }
  const amount = publicManualPrice(product);
  if (amount === undefined) return null;
  return { '@type': 'Offer', priceCurrency: 'USD', price: amount.toFixed(2), url };
}

export function catalogProductSchema(
  product: Product,
  origin: string | URL,
  options: { published: boolean },
): CatalogSchemaNode | null {
  if (!options.published || !hasAddressableProductDetail(product)) {
    return null;
  }
  const schema: CatalogSchemaNode = {
    '@type': 'Product',
    name: product.name,
    url: absoluteUrl(`/products/item/?slug=${encodeURIComponent(product.slug.trim())}`, origin),
  };
  schema.description = product.description.trim();
  if (product.skuCode?.trim()) schema.sku = product.skuCode.trim();
  const images = (product.images ?? []).filter(Boolean).map((image) => absoluteUrl(image, origin));
  if (images.length > 0) schema.image = images;
  const offer = realOffer(product, origin);
  if (offer) schema.offers = offer;
  return schema;
}

export function serializeCatalogSchema(nodes: readonly CatalogSchemaNode[]): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replaceAll(
    '<',
    '\\u003c',
  );
}
