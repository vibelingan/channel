import { catalogContentView } from '../../catalog/presentation/catalog-content-view.ts';
import type { Product } from '../../islands/shop/catalog-types.ts';
import { catalogBreadcrumbSchema, familyBreadcrumbs, hubBreadcrumbs } from '../catalog-seo.ts';
import { canonicalUrl, createPageDescriptor } from './page.ts';
import { productPath } from './product-identity.ts';
import type { ProductSnapshotEntry } from './product-snapshot.ts';

export function productBreadcrumbs(product: Product) {
  const family = product.productFamily;
  const labels = {
    headphones: 'Headphones',
    'ai-gadgets': 'AI Gadgets',
    toys: 'Toys',
    misc: 'Misc',
  };
  return [
    ...(family ? familyBreadcrumbs(labels[family], `/${family}/`) : hubBreadcrumbs()),
    { label: product.name, href: productPath(product._id) },
  ];
}

function bodySummary(entry: ProductSnapshotEntry): string {
  const detail = entry.detail;
  if (!detail) return entry.product.description ?? '';
  // Structured-content presentation uses approved notes instead of descriptionText.
  return ('content' in detail ? detail.content.notes.join(' ') : detail.descriptionText) ?? '';
}

export function productPageDescriptor(
  entry: ProductSnapshotEntry,
  origin: string,
  brand: string,
  duplicateName = false,
) {
  const { product, detail } = entry;
  const path = productPath(product._id);
  const url = canonicalUrl(path, origin);
  const identity = duplicateName ? ` (${product._id})` : '';
  const name = detail?.name ?? product.name;
  const summary = bodySummary(entry).replace(/\s+/g, ' ').trim();
  const description = `${name}${identity}. ${summary ? summary.slice(0, 180) : 'View product specifications, photos and quotation options.'}`;
  const schema: Record<string, unknown> = { '@type': 'Product', name, url };
  if (summary) schema.description = summary;
  const images = detail?.images ?? product.images ?? [];
  if (images.length) schema.image = images.map((image) => new URL(image, origin).href);
  if (detail) {
    const facts = catalogContentView(
      detail.facts,
      'content' in detail ? detail.content : undefined,
    ).specifications;
    if (facts.length)
      schema.additionalProperty = facts.map(({ name, value }) => ({
        '@type': 'PropertyValue',
        name,
        value,
      }));
  } else if (product.skuCode) schema.sku = product.skuCode;
  // Product and selected-configuration prices have different scopes. Do not
  // derive a product-wide Offer from an incomplete initial variant page.
  return createPageDescriptor({
    path,
    kind: 'product',
    title: `${name}${identity} | ${brand}`,
    description,
    content: {
      source: detail ? 'public-catalog-detail' : 'public-catalog-legacy',
      revision: entry.revision,
    },
    schemaNodes: [
      schema,
      catalogBreadcrumbSchema(productBreadcrumbs({ ...product, name }), origin),
    ],
  });
}
