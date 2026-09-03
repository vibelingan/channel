import { type ProductFamily, isProductFamily } from '@vibelingan-channel/shared';
import {
  createAlibabaPricingAdapter,
  resolveCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import {
  type CatalogSeoOffer,
  toCatalogSeoView,
} from '../catalog/presentation/catalog-seo-view.ts';
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
  return toCatalogSeoView(product, { source: 'quote-required' }).canonicalPath !== undefined;
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

function schemaOffer(offer: CatalogSeoOffer, url: string): CatalogSchemaNode {
  const eligibleQuantity =
    offer.minimumOrderQuantity === undefined
      ? {}
      : {
          eligibleQuantity: {
            '@type': 'QuantitativeValue',
            minValue: offer.minimumOrderQuantity,
          },
        };
  return offer.type === 'Offer'
    ? {
        '@type': offer.type,
        priceCurrency: offer.priceCurrency,
        price: offer.price,
        url,
        ...eligibleQuantity,
      }
    : {
        '@type': offer.type,
        priceCurrency: offer.priceCurrency,
        lowPrice: offer.lowPrice,
        highPrice: offer.highPrice,
        url,
        ...eligibleQuantity,
      };
}

export function catalogProductSchema(
  product: Product,
  origin: string | URL,
  options: { published: boolean },
): CatalogSchemaNode | null {
  const { alibabaPrimarySourceKey, ...unlinkedProduct } = product;
  const pricing = resolveCatalogPricing(
    alibabaPrimarySourceKey == null ? unlinkedProduct : product,
    createAlibabaPricingAdapter(),
  );
  const view = toCatalogSeoView(product, pricing);
  if (!options.published || !view.canonicalPath) return null;
  const schema: CatalogSchemaNode = {
    '@type': 'Product',
    name: view.name,
    url: absoluteUrl(view.canonicalPath, origin),
  };
  schema.description = view.description;
  if (view.sku) schema.sku = view.sku;
  const images = view.images.map((image) => absoluteUrl(image, origin));
  if (images.length > 0) schema.image = images;
  if (view.offer) schema.offers = schemaOffer(view.offer, absoluteUrl(view.canonicalPath, origin));
  return schema;
}

export function serializeCatalogSchema(nodes: readonly CatalogSchemaNode[]): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replaceAll(
    '<',
    '\\u003c',
  );
}
