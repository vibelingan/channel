import { createHash } from 'node:crypto';
import {
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  productFamilyForDoc,
} from '@vibelingan-channel/shared';
import type { CatalogPage } from '../../islands/shop/catalog-types.ts';
import { CATALOG_PAGE_SIZE, catalogPagePath } from '../../islands/shop/numbered-catalog-state.ts';
import type { ProductSnapshot } from './product-snapshot.ts';

export interface CategoryPageData extends CatalogPage {
  family: ProductFamily;
  pageCount: number;
  path: string;
  revision: string;
  previousPath: string | null;
  nextPath: string | null;
}

function contentRevision(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/** Reuse the verified public inventory; building category pages adds no API requests. */
function categoryPagesWithFamilyRevision(snapshot: ProductSnapshot) {
  return PRODUCT_FAMILY_OPTIONS.flatMap((family) => {
    const entries = snapshot.products
      .filter(({ product }) => productFamilyForDoc(product) === family)
      .sort((left, right) =>
        left.product._id < right.product._id ? -1 : left.product._id > right.product._id ? 1 : 0,
      );
    const total = entries.length;
    const pageCount = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
    // The recovery manifest still binds the whole category to one inventory.
    // Only the page's own content revision is embedded in its HTML.
    const content = entries.map(({ product, revision }) => [product, revision]);
    const familyRevision = contentRevision(content);
    return Array.from({ length: pageCount }, (_, index) => {
      const page = index + 1;
      const start = index * CATALOG_PAGE_SIZE;
      const end = start + CATALOG_PAGE_SIZE;
      const data: CategoryPageData = {
        family,
        page,
        pageSize: CATALOG_PAGE_SIZE,
        total,
        pageCount,
        path: catalogPagePath(family, page),
        revision: contentRevision([total, content.slice(start, end)]),
        previousPath: page > 1 ? catalogPagePath(family, page - 1) : null,
        nextPath: page < pageCount ? catalogPagePath(family, page + 1) : null,
        items: entries.slice(start, end).map(({ product }) => product),
      };
      return { data, familyRevision };
    });
  });
}

export function categoryPages(snapshot: ProductSnapshot): CategoryPageData[] {
  return categoryPagesWithFamilyRevision(snapshot).map(({ data }) => data);
}

export function categoryPage(snapshot: ProductSnapshot, family: ProductFamily, page = 1) {
  const found = categoryPages(snapshot).find(
    (item) => item.family === family && item.page === page,
  );
  if (!found) throw new Error(`Category page is outside the verified inventory: ${family}/${page}`);
  return found;
}

export function categoryManifest(snapshot: ProductSnapshot) {
  return {
    schemaVersion: 1,
    purpose: snapshot.purpose,
    siteOrigin: snapshot.siteOrigin,
    pages: categoryPagesWithFamilyRevision(snapshot).map(
      ({ data: { family, page, total, path, items }, familyRevision }) => ({
        family,
        page,
        total,
        path,
        revision: familyRevision,
        productIds: items.map(({ _id }) => _id),
      }),
    ),
  };
}
