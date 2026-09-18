import { getCatalogTaxonomy } from '@vibelingan-channel/db';
import {
  type ApiResult,
  type CatalogTaxonomy,
  CatalogTaxonomySchema,
  type ProductFamily,
  err,
  initialCatalogTaxonomy,
  isProductFamily,
  ok,
} from '@vibelingan-channel/shared';

interface PublicCatalogTaxonomy {
  family: ProductFamily;
  name: string;
  revision: number;
  children: { id: string; name: string; slug: string; order: number }[];
}

export async function readCatalogTaxonomy(
  family: ProductFamily,
): Promise<ApiResult<CatalogTaxonomy>> {
  try {
    const stored = await getCatalogTaxonomy(family);
    if (stored === null) return ok(initialCatalogTaxonomy(family));
    const parsed = CatalogTaxonomySchema.safeParse({
      family: stored.family,
      name: stored.name,
      revision: stored.revision,
      children: stored.children,
    });
    if (!parsed.success || parsed.data.family !== family) {
      return err('INTERNAL_ERROR', 'Catalog taxonomy is unavailable.');
    }
    return ok(parsed.data);
  } catch {
    return err('INTERNAL_ERROR', 'Catalog taxonomy is unavailable.');
  }
}

export async function getPublicCatalogTaxonomy(
  params: URLSearchParams,
): Promise<ApiResult<PublicCatalogTaxonomy>> {
  const families = params.getAll('family');
  const family = families[0];
  if (families.length !== 1 || !isProductFamily(family)) {
    return err('VALIDATION_ERROR', 'Exactly one valid product family is required.');
  }
  const result = await readCatalogTaxonomy(family);
  if (!result.ok) return result;
  const registry = result.data;
  return ok({
    family: registry.family,
    name: registry.name,
    revision: registry.revision,
    children: registry.children
      .filter((child) => child.status === 'active')
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map(({ id, name, slug, order }) => ({ id, name, slug, order })),
  });
}
