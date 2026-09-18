import {
  CatalogTaxonomySchema,
  type CollectionDoc,
  initialCatalogTaxonomy,
  isProductFamily,
  productFamilyForDoc,
  readProductSubcategories,
  validateProductSubcategories,
} from '@vibelingan-channel/shared';
import type { CatalogProductSaveInput, CatalogProductSaveResult } from './adapter.ts';

type ProductSubcategorySavePlan =
  | { result: 'ready'; registryFence?: CollectionDoc }
  | Extract<CatalogProductSaveResult, { result: 'invalid-product' }>;

function invalidClassification(message: string): ProductSubcategorySavePlan {
  return { result: 'invalid-product', issues: [{ field: 'category', message }] };
}

export function planProductSubcategorySave(
  existing: CollectionDoc | null,
  input: CatalogProductSaveInput,
  storedRegistry: CollectionDoc | null,
  actor: CollectionDoc | null = null,
): ProductSubcategorySavePlan {
  const expected = input.expectedClassification;
  if (
    expected &&
    (typeof expected.actorId !== 'string' ||
      expected.actorId.trim().length === 0 ||
      !actor ||
      actor._id !== expected.actorId ||
      actor.role !== 'admin' ||
      actor.status === 'suspended')
  ) {
    return invalidClassification('A current administrator is required to change classification.');
  }
  const explicitIds = Object.hasOwn(input.data, 'subcategoryIds');
  const migrated = existing !== null && Object.hasOwn(existing, 'subcategoryIds');
  if (migrated && Object.hasOwn(input.data, 'category')) {
    if (typeof input.data.category !== 'string' || input.data.category !== existing.category) {
      return invalidClassification(
        'Legacy category cannot change after subcategories are assigned.',
      );
    }
    if (!explicitIds) {
      return invalidClassification(
        'Legacy category writes require explicit subcategory assignments.',
      );
    }
  }
  const family = Object.hasOwn(input.data, 'productFamily')
    ? input.data.productFamily
    : existing?.productFamily;
  const movingFamily = migrated && family !== existing.productFamily;
  if (!explicitIds && !movingFamily) return { result: 'ready' };

  if (!expected) return invalidClassification('Classification version is required.');
  if (
    (input.mode === 'create'
      ? existing !== null || expected.productUpdatedAt !== null
      : !existing ||
        typeof existing.updatedAt !== 'string' ||
        existing.updatedAt.length === 0 ||
        expected.productUpdatedAt !== existing.updatedAt) ||
    !Number.isSafeInteger(expected.taxonomyRevision) ||
    expected.taxonomyRevision < 0
  ) {
    return invalidClassification('Product classification changed. Reload before saving.');
  }
  if (!explicitIds) {
    return invalidClassification('Changing product family requires explicit new subcategories.');
  }
  if (!isProductFamily(family)) {
    return invalidClassification('A valid product family is required for subcategories.');
  }
  const parsed = CatalogTaxonomySchema.safeParse(
    storedRegistry
      ? {
          family: storedRegistry.family,
          revision: storedRegistry.revision,
          name: storedRegistry.name,
          children: storedRegistry.children,
        }
      : initialCatalogTaxonomy(family),
  );
  if (
    !parsed.success ||
    parsed.data.family !== family ||
    (storedRegistry !== null && storedRegistry._id !== family)
  ) {
    return invalidClassification('Subcategory registry is invalid.');
  }
  if (expected.taxonomyRevision !== parsed.data.revision) {
    return invalidClassification('Subcategory registry changed. Reload before saving.');
  }
  const previous =
    existing && productFamilyForDoc(existing) === family
      ? readProductSubcategories(existing, parsed.data)
      : null;
  if (
    !validateProductSubcategories(
      family,
      input.data.subcategoryIds,
      parsed.data,
      previous?.status === 'valid' ? previous.subcategoryIds : [],
    )
  ) {
    return invalidClassification('Subcategories must belong to this family and allow assignment.');
  }
  const fence =
    storedRegistry && Object.hasOwn(storedRegistry, 'assignmentFence')
      ? storedRegistry.assignmentFence
      : 0;
  if (
    typeof fence !== 'number' ||
    !Number.isSafeInteger(fence) ||
    fence < 0 ||
    fence === Number.MAX_SAFE_INTEGER
  ) {
    return invalidClassification('Subcategory assignment fence is invalid or exhausted.');
  }
  return {
    result: 'ready',
    registryFence: {
      ...(storedRegistry ?? parsed.data),
      _id: family,
      assignmentFence: fence + 1,
    },
  };
}
