import { catalogContentView } from '../../catalog/presentation/catalog-content-view.ts';
import type { Product } from '../../islands/shop/catalog-types.ts';
import { catalogBreadcrumbSchema, familyBreadcrumbs, hubBreadcrumbs } from '../catalog-seo.ts';
import { createPageDescriptor } from './page.ts';
import { productPath } from './product-identity.ts';
import type { ProductSnapshotEntry } from './product-snapshot.ts';
import { publicProductRichResult } from './public-offer.ts';

const TITLE_BUDGET = 65;
const DESCRIPTION_BUDGET = 160;
const DEFAULT_DESCRIPTION = 'View product specifications, photos and quotation options.';
const supplierIntroductions = [
  /^Experienced Headphones Manufacturer\s+Channel Technology Ltd is engaged in the research\b/i,
  /^Research\s*&\s*Development\s*One[- ]Stop OEM solution\b/i,
];

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

function productDescription(entry: ProductSnapshotEntry, name: string, identity: string) {
  const summary = bodySummary(entry).replace(/\s+/g, ' ').trim();
  const supplierCopy = supplierIntroductions.some((pattern) => pattern.test(summary));
  const detail = entry.detail;
  const content = detail && 'content' in detail ? detail.content : undefined;
  const fact =
    detail && (!summary || supplierCopy)
      ? catalogContentView(detail.facts, content)
          .highlights.map(({ name, value }) => `${name.trim().replace(/:+$/, '')}: ${value.trim()}`)
          .find((text) => Array.from(text).length <= 60)
      : undefined;
  if (!supplierCopy && !fact)
    return fitIdentity(
      `${name.trim()}. ${summary || DEFAULT_DESCRIPTION}`,
      identity,
      DESCRIPTION_BUDGET,
    );

  const description = fact ? `${fact.replace(/\.$/, '')}.` : DEFAULT_DESCRIPTION;
  const available = DESCRIPTION_BUDGET - Array.from(description + identity).length - 2;
  if (available < 2)
    return fitIdentity(`${name.trim()}. ${description}`, identity, DESCRIPTION_BUDGET);

  const title = shorten(name, available);
  const separator = /[.…!?]$/u.test(title) ? ' ' : '. ';
  return `${title}${separator}${description}${identity}`;
}

export function duplicateProductTitleIds(entries: readonly ProductSnapshotEntry[], brand: string) {
  const duplicates = new Set<string>();
  let previousSize: number;
  do {
    previousSize = duplicates.size;
    const titles = new Map<string, string>();
    for (const entry of entries) {
      const title = productTitle(entry, brand, duplicates.has(entry.product._id));
      const previous = titles.get(title);
      if (previous !== undefined) {
        duplicates.add(previous);
        duplicates.add(entry.product._id);
      }
      titles.set(title, entry.product._id);
    }
  } while (duplicates.size > previousSize);
  return duplicates;
}

export function productPageDescriptor(
  entry: ProductSnapshotEntry,
  origin: string,
  brand: string,
  duplicateName = false,
) {
  const { product, detail } = entry;
  const path = productPath(product._id);
  const identity = duplicateName ? ` (${product._id})` : '';
  const name = detail?.name ?? product.name;
  const description = productDescription(entry, name, identity);
  const richResult = publicProductRichResult(entry, origin, description);
  return createPageDescriptor({
    path,
    kind: 'product',
    title: productTitle(entry, brand, duplicateName),
    description,
    content: {
      source: detail ? 'public-catalog-detail' : 'public-catalog-legacy',
      revision: entry.revision,
      ...(entry.publicVersion?.changedAt ? { updatedAt: entry.publicVersion.changedAt } : {}),
    },
    schemaNodes: [
      catalogBreadcrumbSchema(productBreadcrumbs({ ...product, name }), origin),
      ...(richResult.status === 'eligible' ? [richResult.schema] : []),
    ],
  });
}

function productTitle(entry: ProductSnapshotEntry, brand: string, duplicateName: boolean) {
  const name = (entry.detail?.name ?? entry.product.name).replace(/\s+/g, ' ').trim();
  const identity = duplicateName ? ` (${entry.product._id})` : '';
  const full = `${name}${identity}`;
  const branded = `${full} | ${brand.trim()}`;
  if (brand.trim() && Array.from(branded).length <= TITLE_BUDGET) return branded;
  return fitIdentity(name, identity, TITLE_BUDGET);
}

function fitIdentity(text: string, identity: string, budget: number) {
  const nameBudget = budget - Array.from(identity).length;
  // Display budgets must never discard an identity or reject a valid historical product.
  return nameBudget < 2 ? `${text}${identity}` : `${shorten(text, nameBudget)}${identity}`;
}

function shorten(input: string, budget: number): string {
  const text = input.replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  if (characters.length <= budget) return text;
  const prefix = characters.slice(0, budget - 1).join('');
  const boundary = prefix.lastIndexOf(' ');
  const words =
    boundary > 0 && !/\s/u.test(characters[budget - 1]) ? prefix.slice(0, boundary) : prefix;
  return `${words.trimEnd()}…`;
}
