import {
  type CatalogClassificationAssignmentRequest,
  CatalogClassificationAssignmentRequestSchema,
  type CatalogClassificationAssignmentResult,
  type CatalogTaxonomy,
  type CollectionDoc,
  type ProductFamily,
  productFamilyForDoc,
  readProductSubcategories,
  validateProductSubcategories,
} from '@vibelingan-channel/shared';
import { AdminApiError, taxonomyCall } from './api.ts';

export function taxonomyQuery(family: ProductFamily) {
  return {
    queryKey: ['catalog-taxonomy', family] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<CatalogTaxonomy> => {
      const result = await taxonomyCall({ kind: 'taxonomy', operation: 'read', family }, signal);
      if (!('registry' in result)) {
        throw new AdminApiError(
          result.status,
          `Categories could not be loaded (${result.status}).`,
        );
      }
      return result.registry;
    },
    retry: false as const,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  };
}

export function initialClassification(
  products: readonly CollectionDoc[],
  registry: CatalogTaxonomy,
): { ids: string[]; error: string | null } {
  const sameFamily = products.filter((product) => productFamilyForDoc(product) === registry.family);
  const states = sameFamily.map((product) => readProductSubcategories(product, registry));
  if (states.some((state) => state.status === 'invalid')) {
    return {
      ids: [],
      error: 'Existing product subcategories are malformed. Refresh products before assigning.',
    };
  }
  const single = products.length === 1 ? states[0] : undefined;
  return { ids: single?.status === 'valid' ? single.subcategoryIds : [], error: null };
}

export function classificationChoices(
  products: readonly CollectionDoc[],
  registry: CatalogTaxonomy,
  selectedIds: readonly string[],
) {
  return [...registry.children]
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map((child) => {
      const canRetain =
        products.length > 0 &&
        products.every((product) => {
          const state = readProductSubcategories(product, registry);
          return state.status === 'valid' && state.subcategoryIds.includes(child.id);
        });
      const current = products.some((product) => {
        const state = readProductSubcategories(product, registry);
        return state.status === 'valid' && state.subcategoryIds.includes(child.id);
      });
      return {
        child,
        current,
        selected: selectedIds.includes(child.id),
        disabled: child.status === 'archived' && !canRetain,
      };
    });
}

export function classificationRequest(
  products: readonly CollectionDoc[],
  registry: CatalogTaxonomy,
  operation: CatalogClassificationAssignmentRequest['operation'],
  subcategoryIds: string[],
): CatalogClassificationAssignmentRequest {
  if (operation === 'append' && subcategoryIds.length === 0) {
    throw new Error('Choose at least one subcategory to append.');
  }
  if (
    operation !== 'replace' &&
    products.some((product) => productFamilyForDoc(product) !== registry.family)
  ) {
    throw new Error('Append and clear require every product to have the selected main category.');
  }
  const initial = initialClassification(products, registry);
  if (initial.error) throw new Error(initial.error);
  for (const product of products) {
    const sameFamily = productFamilyForDoc(product) === registry.family;
    if (!sameFamily && product.published === true) {
      throw new Error('Withdraw published products before changing their main category.');
    }
    const previous = sameFamily ? readProductSubcategories(product, registry) : null;
    const previousIds = previous?.status === 'valid' ? previous.subcategoryIds : [];
    const nextIds =
      operation === 'append' ? [...new Set([...previousIds, ...subcategoryIds])] : subcategoryIds;
    if (!validateProductSubcategories(registry.family, nextIds, registry, previousIds)) {
      throw new Error(
        'Choose up to 16 valid subcategories. Archived subcategories can only be retained.',
      );
    }
  }
  const parsed = CatalogClassificationAssignmentRequestSchema.safeParse({
    kind: 'assignment',
    operation,
    family: registry.family,
    taxonomyRevision: registry.revision,
    products: products.map((product) => ({
      productId: product._id,
      expectedUpdatedAt: product.updatedAt,
    })),
    subcategoryIds,
  });
  if (!parsed.success)
    throw new Error(
      'Select 1 to 20 distinct products with current timestamps and valid subcategories. Refresh products if needed.',
    );
  return parsed.data;
}

export function summarizeAssignment(result: CatalogClassificationAssignmentResult) {
  const uncertain =
    result.refreshRequired === true ||
    result.results.some((item) => item.status === 'unknown' || item.status === 'notattempted');
  return {
    uncertain,
    allSaved:
      !uncertain &&
      result.results.length > 0 &&
      result.results.every((item) => item.status === 'saved'),
  };
}
