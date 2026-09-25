import {
  get,
  manageCatalogCategory,
  saveCatalogProductWithIdentities,
} from '@vibelingan-channel/db';
import {
  type CatalogExpectedSuggestion,
  CatalogExpectedSuggestionSchema,
} from '@vibelingan-channel/db/adapter';
import {
  type CatalogClassificationAssignmentRequest,
  CatalogClassificationAssignmentRequestSchema,
  type CatalogClassificationAssignmentResult,
  CatalogClassificationAssignmentResultSchema,
  CatalogTaxonomyResultSchema,
  productFamilyForDoc,
  readProductSubcategories,
  validateProductSubcategories,
} from '@vibelingan-channel/shared';

type AssignmentItem = CatalogClassificationAssignmentRequest['products'][number];
type AssignmentStatus = CatalogClassificationAssignmentResult['results'][number]['status'];

async function readAssignmentState(
  actorId: string,
  command: CatalogClassificationAssignmentRequest,
  item: AssignmentItem,
) {
  const product = await get('products', item.productId);
  if (!product) return { status: 'missing' } as const;
  if (product.updatedAt !== item.expectedUpdatedAt) return { status: 'conflict' } as const;
  const taxonomy = CatalogTaxonomyResultSchema.parse(
    await manageCatalogCategory(actorId, {
      kind: 'taxonomy',
      operation: 'read',
      family: command.family,
    }),
  );
  if (!('registry' in taxonomy)) return { status: taxonomy.status };
  if (taxonomy.registry.family !== command.family) return { status: 'invalid' } as const;
  if (taxonomy.registry.revision !== command.taxonomyRevision)
    return { status: 'conflict' } as const;
  return { status: 'ready', product, registry: taxonomy.registry } as const;
}

async function assignProduct(
  actorId: string,
  command: CatalogClassificationAssignmentRequest,
  item: AssignmentItem,
  expectedSuggestion?: CatalogExpectedSuggestion,
): Promise<AssignmentStatus | { status: 'saved'; updatedAt: string }> {
  const actor = await get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended') return 'forbidden';
  const state = await readAssignmentState(actorId, command, item);
  if (state.status !== 'ready') return state.status;
  const { product, registry } = state;
  const sameFamily = productFamilyForDoc(product) === command.family;
  if (!sameFamily && command.operation !== 'replace') return 'invalid';
  if (!sameFamily && product.published === true) return 'forbidden';
  const previous = sameFamily ? readProductSubcategories(product, registry) : null;
  if (command.operation === 'append' && previous?.status !== 'valid') return 'invalid';
  const previousIds = previous?.status === 'valid' ? previous.subcategoryIds : [];
  const subcategoryIds =
    command.operation === 'append'
      ? [...new Set([...previousIds, ...command.subcategoryIds])]
      : command.subcategoryIds;
  if (!validateProductSubcategories(command.family, subcategoryIds, registry, previousIds)) {
    return 'invalid';
  }
  const result = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId: item.productId,
    data: { productFamily: command.family, subcategoryIds },
    expectedClassification: {
      actorId,
      productUpdatedAt: item.expectedUpdatedAt,
      taxonomyRevision: command.taxonomyRevision,
    },
    requireDetailApproval: true,
    ...(expectedSuggestion ? { expectedSuggestion } : {}),
  });
  switch (result.result) {
    case 'saved':
      if (command.includeSavedRevision) {
        if (typeof result.doc.updatedAt !== 'string')
          throw new Error('Saved product has no revision');
        return { status: 'saved', updatedAt: result.doc.updatedAt };
      }
      return 'saved';
    case 'missing':
      return result.result;
    case 'conflict':
    case 'exists':
    case 'alibaba-identity-conflict':
      return 'conflict';
    case 'invalid':
      return 'invalid';
    case 'invalid-product': {
      const latest = await readAssignmentState(actorId, command, item);
      return latest.status === 'ready' ? 'invalid' : latest.status;
    }
    default:
      throw new Error('Unrecognized classification save result');
  }
}

export async function manageCatalogClassificationAssignment(
  actorId: string,
  input: unknown,
  suggestion?: unknown,
): Promise<CatalogClassificationAssignmentResult> {
  const command = CatalogClassificationAssignmentRequestSchema.parse(input);
  const expectedSuggestion =
    suggestion === undefined ? undefined : CatalogExpectedSuggestionSchema.parse(suggestion);
  const results: CatalogClassificationAssignmentResult['results'] = [];
  let interrupted = false;
  for (const item of command.products) {
    if (interrupted) {
      results.push({ productId: item.productId, status: 'notattempted' });
      continue;
    }
    try {
      const saved = await assignProduct(actorId, command, item, expectedSuggestion);
      results.push({
        productId: item.productId,
        ...(typeof saved === 'string' ? { status: saved } : saved),
      });
    } catch {
      results.push({ productId: item.productId, status: 'unknown' });
      interrupted = true;
    }
  }
  return CatalogClassificationAssignmentResultSchema.parse({
    kind: 'assignment',
    results,
    ...(interrupted ? { refreshRequired: true } : {}),
  });
}
