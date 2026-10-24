import { Buffer } from 'node:buffer';
import { get, getCatalogTaxonomy, list } from '@vibelingan-channel/db';
import {
  resolveCatalogMappingEvidence,
  sourceCategoryOf,
} from '@vibelingan-channel/db/category-transaction';
import {
  CatalogClassificationAssignmentRequestSchema,
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  isProductFamily,
} from '@vibelingan-channel/shared';
import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const commandSchema = z.object({ kind: z.literal('suggestion'), productId: identifier }).strict();
const evidenceSchema = z
  .object({
    kind: z.literal('suggestion'),
    productId: identifier,
    status: z.literal('ready'),
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

export async function validateSuggestedAssignment(
  actorId: string,
  input: unknown,
  reader: { get: typeof get; list: typeof list } = { get, list },
): Promise<boolean> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !('expectedSuggestion' in input)
  )
    return false;
  const { expectedSuggestion, ...assignment } = input;
  const command = CatalogClassificationAssignmentRequestSchema.parse(assignment);
  const expected = evidenceSchema.parse(expectedSuggestion);
  const product = command.products[0];
  if (
    command.products.length !== 1 ||
    command.operation !== 'replace' ||
    product?.productId !== expected.productId ||
    product.expectedUpdatedAt !== expected.productUpdatedAt ||
    command.family !== expected.family ||
    command.taxonomyRevision !== expected.taxonomyRevision ||
    JSON.stringify(command.subcategoryIds) !== JSON.stringify(expected.subcategoryIds)
  )
    return false;
  const current = await readCatalogCategorySuggestion(
    actorId,
    { kind: 'suggestion', productId: expected.productId },
    reader,
  );
  return (
    current.status === 'ready' &&
    JSON.stringify(evidenceSchema.parse(current)) === JSON.stringify(expected)
  );
}

export type CatalogCategorySuggestion =
  | {
      kind: 'suggestion';
      productId: string;
      status: 'ready';
      productUpdatedAt: string;
      source: { primarySourceKey: string; sourceCategoryId: string };
      mapping: { id: string; revision: string };
      family: ProductFamily;
      subcategoryIds: string[];
      taxonomyRevision: number;
    }
  | {
      kind: 'suggestion';
      productId: string;
      status:
        | 'forbidden'
        | 'missing'
        | 'no-source'
        | 'unmapped'
        | 'review-required'
        | 'conflict'
        | 'invalid';
    };

export async function readCatalogCategorySuggestion(
  actorId: string,
  input: unknown,
  reader: { get: typeof get; list: typeof list } = { get, list },
): Promise<CatalogCategorySuggestion> {
  const serialized = JSON.stringify(input);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 16 * 1024)
    throw new z.ZodError([
      { code: 'custom', path: [], message: 'Suggestion request is too large.' },
    ]);
  const command = commandSchema.parse(input);
  const base = { kind: 'suggestion' as const, productId: command.productId };
  const actor = await reader.get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended')
    return { ...base, status: 'forbidden' };
  const product = await reader.get('products', command.productId);
  if (!product) return { ...base, status: 'missing' };
  const sourceKey = identifier.safeParse(product.alibabaPrimarySourceKey);
  if (!sourceKey.success) return { ...base, status: 'no-source' };
  const sourceCategoryId = sourceCategoryOf(product);
  const timestamp = z.string().datetime().safeParse(product.updatedAt);
  if (!/^\d{1,200}$/.test(sourceCategoryId) || !timestamp.success)
    return { ...base, status: 'conflict' };
  const [source, link] = await Promise.all([
    reader.get('alibabaSourceProducts', sourceKey.data),
    reader.get('alibabaProductLinks', sourceKey.data),
  ]);
  if (
    product._id !== command.productId ||
    source?._id !== sourceKey.data ||
    source.active !== true ||
    source.sourceCategoryId !== sourceCategoryId ||
    link?._id !== sourceKey.data ||
    link.productId !== product._id
  )
    return { ...base, status: 'conflict' };
  const matches = await reader.list({
    collection: 'sourceCategoryMappings',
    page: 1,
    pageSize: 2,
    filter: {
      combinator: 'and',
      clauses: [
        { field: 'provider', op: 'eq', value: 'alibaba' },
        { field: 'sourceTaxonomy', op: 'eq', value: 'alibaba:icbu' },
        { field: 'sourceCategoryId', op: 'eq', value: sourceCategoryId },
      ],
    },
  });
  if (matches.total === 0 && matches.items.length === 0) return { ...base, status: 'unmapped' };
  if (matches.total !== 1 || matches.items.length !== 1) return { ...base, status: 'conflict' };
  const mapping = matches.items[0];
  if (!mapping) return { ...base, status: 'conflict' };
  if (mapping.reviewRequired === true) return { ...base, status: 'review-required' };
  if (
    !identifier.safeParse(mapping._id).success ||
    mapping.provider !== 'alibaba' ||
    mapping.sourceTaxonomy !== 'alibaba:icbu' ||
    mapping.sourceCategoryId !== sourceCategoryId ||
    (mapping.reviewRequired !== undefined && mapping.reviewRequired !== false) ||
    !isProductFamily(mapping.productFamily)
  )
    return { ...base, status: 'invalid' };
  const family = mapping.productFamily;
  const stored = await (reader.get === get
    ? getCatalogTaxonomy(family)
    : reader.get('catalogTaxonomies', family));
  const evidence = resolveCatalogMappingEvidence(mapping, stored);
  if (evidence.status !== 'ready') return { ...base, status: evidence.status };
  return {
    ...base,
    ...evidence,
    productUpdatedAt: timestamp.data,
    source: { primarySourceKey: sourceKey.data, sourceCategoryId },
  };
}
