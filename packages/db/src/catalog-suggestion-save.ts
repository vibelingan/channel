import { type CollectionDoc, PRODUCT_FAMILY_OPTIONS } from '@vibelingan-channel/shared';
import { z } from 'zod';
import type { CatalogProductSaveInput, CatalogProductSaveResult } from './adapter.ts';
import { resolveCatalogMappingEvidence } from './catalog-mapping-transaction.ts';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);

export const CatalogExpectedSuggestionSchema = z
  .object({
    kind: z.literal('suggestion'),
    status: z.literal('ready').optional(),
    productId: identifier,
    productUpdatedAt: z.string().datetime(),
    source: z
      .object({ primarySourceKey: identifier, sourceCategoryId: z.string().regex(/^\d{1,200}$/) })
      .strict(),
    mapping: z.object({ id: identifier, revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    family: z.enum(PRODUCT_FAMILY_OPTIONS),
    subcategoryIds: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/))
      .max(16)
      .refine((ids) => new Set(ids).size === ids.length),
    taxonomyRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type CatalogExpectedSuggestion = z.infer<typeof CatalogExpectedSuggestionSchema>;

export interface CatalogSuggestionSaveDocuments {
  source: CollectionDoc | null;
  link: CollectionDoc | null;
  mapping: CollectionDoc | null;
  registry: CollectionDoc | null;
}

export interface CatalogSuggestionSaveFence {
  collection: 'alibabaSourceProducts' | 'alibabaProductLinks' | 'sourceCategoryMappings';
  doc: CollectionDoc;
}

type CatalogSuggestionSavePlan =
  | { result: 'ready'; fences: CatalogSuggestionSaveFence[] }
  | Extract<CatalogProductSaveResult, { result: 'invalid-product' }>;

export function parseCatalogExpectedSuggestion(input: unknown): CatalogExpectedSuggestion | null {
  const parsed = CatalogExpectedSuggestionSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function catalogSuggestionChanged(): Extract<
  CatalogProductSaveResult,
  { result: 'invalid-product' }
> {
  return {
    result: 'invalid-product',
    issues: [
      { field: 'category', message: 'Product classification changed. Reload before saving.' },
    ],
  };
}

function sameSubcategories(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((id, index) => actual[index] === id)
  );
}

export function planCatalogSuggestionSave(
  existing: CollectionDoc | null,
  input: CatalogProductSaveInput,
  documents: CatalogSuggestionSaveDocuments,
  categoryAssignmentFence: string,
): CatalogSuggestionSavePlan {
  if (input.expectedSuggestion === undefined) return { result: 'ready', fences: [] };
  const expected = parseCatalogExpectedSuggestion(input.expectedSuggestion);
  if (!expected) return catalogSuggestionChanged();
  const classification = input.expectedClassification;
  if (
    input.mode !== 'update' ||
    !existing ||
    existing._id !== expected.productId ||
    input.productId !== expected.productId ||
    existing.updatedAt !== expected.productUpdatedAt ||
    existing.alibabaPrimarySourceKey !== expected.source.primarySourceKey ||
    classification?.productUpdatedAt !== expected.productUpdatedAt ||
    classification.taxonomyRevision !== expected.taxonomyRevision ||
    input.data.productFamily !== expected.family ||
    !sameSubcategories(input.data.subcategoryIds, expected.subcategoryIds)
  )
    return catalogSuggestionChanged();

  const review = existing.alibabaSourceReview;
  if (
    review !== undefined &&
    review !== null &&
    (typeof review !== 'object' || Array.isArray(review))
  )
    return catalogSuggestionChanged();
  const nested =
    review && typeof review === 'object' ? Reflect.get(review, 'sourceCategoryId') : undefined;
  const direct = existing.alibabaSourceCategoryId;
  if (
    (direct !== undefined && direct !== expected.source.sourceCategoryId) ||
    (nested !== undefined && nested !== expected.source.sourceCategoryId) ||
    (direct === undefined && nested === undefined)
  )
    return catalogSuggestionChanged();

  const { source, link, mapping, registry } = documents;
  if (
    !source ||
    source._id !== expected.source.primarySourceKey ||
    source.active !== true ||
    source.sourceCategoryId !== expected.source.sourceCategoryId ||
    !link ||
    link._id !== expected.source.primarySourceKey ||
    link.productId !== expected.productId ||
    !mapping ||
    mapping._id !== expected.mapping.id ||
    mapping.provider !== 'alibaba' ||
    mapping.sourceTaxonomy !== 'alibaba:icbu' ||
    mapping.sourceCategoryId !== expected.source.sourceCategoryId
  )
    return catalogSuggestionChanged();
  const evidence = resolveCatalogMappingEvidence(mapping, registry);
  if (
    evidence.status !== 'ready' ||
    evidence.mapping.id !== expected.mapping.id ||
    evidence.mapping.revision !== expected.mapping.revision ||
    evidence.family !== expected.family ||
    !sameSubcategories(evidence.subcategoryIds, expected.subcategoryIds) ||
    evidence.taxonomyRevision !== expected.taxonomyRevision
  )
    return catalogSuggestionChanged();

  return {
    result: 'ready',
    fences: [
      { collection: 'alibabaSourceProducts', doc: { ...source, categoryAssignmentFence } },
      { collection: 'alibabaProductLinks', doc: { ...link, categoryAssignmentFence } },
      { collection: 'sourceCategoryMappings', doc: { ...mapping, categoryAssignmentFence } },
    ],
  };
}
