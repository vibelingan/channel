import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import {
  CatalogTaxonomySchema,
  type CollectionDoc,
  type ProductFamily,
  buildWriteSchema,
  getCollection,
  initialCatalogTaxonomy,
  isProductFamily,
  readProductSubcategories,
  validateProductSubcategories,
} from '@vibelingan-channel/shared';
import { z } from 'zod';
import { categoryRuleId } from './catalog-classification.ts';
import type { CategoryTransaction } from './category-transaction.ts';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const timestamp = z.string().datetime({ offset: true });
const commandSchema = z
  .object({
    kind: z.literal('mapping'),
    id: identifier,
    expectedUpdatedAt: timestamp.nullable(),
    data: z.record(z.unknown()),
  })
  .strict();

export type CatalogMappingResult = {
  kind: 'mapping';
  status: 'configured' | 'applied' | 'conflict' | 'forbidden' | 'invalid' | 'missing';
  doc?: CollectionDoc;
  message?: string;
};

export function resolveCatalogMappingEvidence(
  mapping: CollectionDoc,
  stored: CollectionDoc | null,
):
  | { status: 'invalid' | 'review-required' }
  | {
      status: 'ready';
      mapping: { id: string; revision: string };
      family: ProductFamily;
      subcategoryIds: string[];
      taxonomyRevision: number;
    } {
  if (mapping.reviewRequired === true) return { status: 'review-required' };
  if (
    !identifier.safeParse(mapping._id).success ||
    mapping.provider !== 'alibaba' ||
    mapping.sourceTaxonomy !== 'alibaba:icbu' ||
    typeof mapping.sourceCategoryId !== 'string' ||
    !/^\d{1,200}$/.test(mapping.sourceCategoryId) ||
    (mapping.reviewRequired !== undefined && mapping.reviewRequired !== false) ||
    !isProductFamily(mapping.productFamily)
  )
    return { status: 'invalid' };
  const family = mapping.productFamily;
  const parsedRegistry = CatalogTaxonomySchema.safeParse(
    stored
      ? {
          family: stored.family,
          revision: stored.revision,
          name: stored.name,
          children: stored.children,
        }
      : initialCatalogTaxonomy(family),
  );
  if (
    !parsedRegistry.success ||
    parsedRegistry.data.family !== family ||
    (stored && stored._id !== family)
  )
    return { status: 'invalid' };
  const registry = parsedRegistry.data;
  const classification = readProductSubcategories(
    Object.hasOwn(mapping, 'subcategoryIds')
      ? { productFamily: family, subcategoryIds: mapping.subcategoryIds }
      : { productFamily: family, category: mapping.channelCategory ?? '' },
    registry,
  );
  if (
    classification.status !== 'valid' ||
    !validateProductSubcategories(family, classification.subcategoryIds, registry)
  )
    return { status: 'invalid' };
  return {
    status: 'ready',
    mapping: {
      id: mapping._id,
      revision: createHash('sha256')
        .update(
          JSON.stringify([
            mapping._id,
            mapping.provider,
            mapping.sourceTaxonomy,
            mapping.sourceCategoryId,
            mapping.productFamily,
            mapping.subcategoryIds,
            mapping.channelCategory,
            mapping.reviewRequired,
            mapping.policyVersion,
            mapping.updatedAt,
          ]),
        )
        .digest('hex'),
    },
    family,
    subcategoryIds: classification.subcategoryIds,
    taxonomyRevision: registry.revision,
  };
}

export async function runCatalogMappingCommand(
  tx: CategoryTransaction,
  actorId: string,
  input: unknown,
  now: string,
): Promise<CatalogMappingResult> {
  const invalid = (message?: string): CatalogMappingResult => ({
    kind: 'mapping',
    status: 'invalid',
    ...(message ? { message } : {}),
  });
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 16 * 1024)
      return invalid('Category mapping request is too large.');
  } catch {
    return invalid();
  }
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success || !timestamp.safeParse(now).success) return invalid();
  if (!identifier.safeParse(actorId).success) return { kind: 'mapping', status: 'forbidden' };
  const actor = await tx.get('users', actorId);
  if (actor?._id !== actorId || actor.role !== 'admin' || actor.status === 'suspended')
    return { kind: 'mapping', status: 'forbidden' };
  const command = parsed.data;
  const previous = await tx.get('sourceCategoryMappings', command.id);
  if (command.expectedUpdatedAt === null) {
    if (previous) return { kind: 'mapping', status: 'conflict' };
  } else {
    if (!previous) return { kind: 'mapping', status: 'missing' };
    if (previous._id !== command.id || previous.updatedAt !== command.expectedUpdatedAt)
      return { kind: 'mapping', status: 'conflict' };
  }
  const definition = getCollection('sourceCategoryMappings');
  if (!definition) return invalid();
  const schema = buildWriteSchema(definition);
  const patch = (previous ? schema.partial() : schema).safeParse(command.data);
  if (!patch.success) return invalid(patch.error.issues[0]?.message);
  const merged = { ...previous, ...patch.data };
  const alibaba = merged.provider === 'alibaba' && merged.sourceTaxonomy === 'alibaba:icbu';
  const wasAlibaba = previous?.provider === 'alibaba' && previous.sourceTaxonomy === 'alibaba:icbu';
  if (
    previous &&
    (alibaba || wasAlibaba) &&
    ['provider', 'sourceTaxonomy', 'sourceCategoryId'].some((key) => merged[key] !== previous[key])
  )
    return invalid('A mapping source identity cannot be changed. Create a separate rule.');
  if (
    alibaba &&
    (typeof merged.sourceCategoryId !== 'string' || !/^\d{1,200}$/.test(merged.sourceCategoryId))
  )
    return invalid('Alibaba category ID must be the numeric ID returned by the API.');
  if (
    (!previous && alibaba && command.id !== categoryRuleId(String(merged.sourceCategoryId))) ||
    (command.id.startsWith(categoryRuleId('')) &&
      (!alibaba || command.id !== categoryRuleId(String(merged.sourceCategoryId))))
  )
    return invalid('The deterministic mapping ID is reserved for its Alibaba source identity.');
  if (merged.reviewRequired !== true && !isProductFamily(merged.productFamily))
    return invalid('Choose a website category or require manual assignment.');

  let taxonomy: CollectionDoc | null = null;
  if (Object.hasOwn(merged, 'subcategoryIds')) {
    const family = merged.productFamily;
    if (!isProductFamily(family))
      return invalid('Choose a website category for the subcategories.');
    const stored = await tx.get('catalogTaxonomies', family);
    const registry = CatalogTaxonomySchema.safeParse(
      stored
        ? {
            family: stored.family,
            revision: stored.revision,
            name: stored.name,
            children: stored.children,
          }
        : initialCatalogTaxonomy(family),
    );
    if (
      !registry.success ||
      registry.data.family !== family ||
      (stored && stored._id !== family) ||
      !validateProductSubcategories(family, merged.subcategoryIds, registry.data)
    )
      return invalid(
        'Choose up to 16 distinct active subcategories from the selected website category.',
      );
    if (
      typeof patch.data.channelCategory === 'string' &&
      patch.data.channelCategory !== '' &&
      (family !== 'headphones' ||
        !Array.isArray(merged.subcategoryIds) ||
        !merged.subcategoryIds.includes(`headphones-${patch.data.channelCategory}`))
    )
      return invalid('The legacy subcategory contradicts the explicit subcategories.');
    taxonomy = { ...stored, ...registry.data, _id: family };
  }
  const updatedAt = new Date(
    Math.max(Date.parse(now), previous?.updatedAt ? Date.parse(previous.updatedAt) + 1 : 0),
  ).toISOString();
  const doc: CollectionDoc = {
    ...merged,
    _id: command.id,
    ...(!previous ? { createdAt: now } : {}),
    updatedAt,
  };
  const categoryAssignmentFence = randomUUID();
  await tx.set('users', { ...actor, categoryAssignmentFence });
  if (taxonomy) await tx.set('catalogTaxonomies', { ...taxonomy, categoryAssignmentFence });
  await tx.set('sourceCategoryMappings', doc);
  return { kind: 'mapping', status: previous ? 'applied' : 'configured', doc };
}
