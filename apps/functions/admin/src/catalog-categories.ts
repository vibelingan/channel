import { randomUUID } from 'node:crypto';
import { get, list, manageCatalogCategory } from '@vibelingan-channel/db';
import {
  APPROVED_CATEGORY_RULES,
  categoryRuleId,
} from '@vibelingan-channel/db/catalog-classification';
import { previewCategory } from '@vibelingan-channel/db/category-transaction';
import {
  CatalogClassificationAssignmentRequestSchema,
  type CatalogClassificationAssignmentResult,
  CatalogTaxonomyCommandSchema,
  type CatalogTaxonomyResult,
  CatalogTaxonomyResultSchema,
  CategoryApiRequestSchema,
  CategoryApiResponseSchema,
  type CollectionDoc,
  buildWriteSchema,
  getCollection,
} from '@vibelingan-channel/shared';
import { z } from 'zod';
import {
  type CatalogCategorySuggestion,
  readCatalogCategorySuggestion,
  validateSuggestedAssignment,
} from './catalog-category-suggestion.ts';
import { manageCatalogClassificationAssignment } from './catalog-classification-assignment.ts';

function mappingError(message: string): never {
  throw new z.ZodError([{ code: 'custom', path: [], message }]);
}

/** Generic mapping editor shares the deterministic Alibaba identity with setup. */
export async function saveCategoryMapping(
  values: Record<string, unknown>,
  id?: string,
  actorId = '',
) {
  const definition = getCollection('sourceCategoryMappings');
  if (!definition) throw new Error('Missing category mapping schema');
  const schema = buildWriteSchema(definition);
  const patch = (id ? schema.partial() : schema).parse(values);
  const previous = id ? await get('sourceCategoryMappings', id) : null;
  if (id && !previous) return null;
  const merged = { ...previous, ...patch };
  const alibaba = merged.provider === 'alibaba' && merged.sourceTaxonomy === 'alibaba:icbu';
  let target = id ?? randomUUID();
  if (!id && alibaba) {
    if (typeof merged.sourceCategoryId !== 'string' || !/^\d+$/.test(merged.sourceCategoryId))
      mappingError('Alibaba category ID must be the numeric ID returned by the API.');
    const categoryId = merged.sourceCategoryId;
    if ((await mappings()).some((row) => row.sourceCategoryId === categoryId))
      mappingError('A mapping already exists for this Alibaba category. Edit the existing rule.');
    target = categoryRuleId(categoryId);
  }
  if (previous && !z.string().datetime({ offset: true }).safeParse(previous.updatedAt).success)
    mappingError('The mapping revision is missing or invalid. Refresh the list.');
  const result = await manageCatalogCategory(actorId, {
    kind: 'mapping',
    id: target,
    expectedUpdatedAt: previous?.updatedAt ?? null,
    data: patch,
  });
  if (result.kind !== 'mapping') mappingError('Unexpected category mapping result.');
  if (result.status === 'missing') return null;
  if ((result.status === 'configured' || result.status === 'applied') && result.doc)
    return result.doc;
  mappingError(result.message ?? `Category mapping ${result.status}. Refresh and retry.`);
}

async function mappings() {
  const rows: CollectionDoc[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await list({
      collection: 'sourceCategoryMappings',
      page,
      pageSize: 100,
      filter: {
        combinator: 'and',
        clauses: [
          { field: 'provider', op: 'eq', value: 'alibaba' },
          { field: 'sourceTaxonomy', op: 'eq', value: 'alibaba:icbu' },
        ],
      },
    });
    rows.push(...result.items);
    if (rows.length >= result.total) return rows;
  }
  throw new Error('Category mapping limit exceeded');
}

/** Same bounded, authenticated action in local-server and the deployed admin function. */
export function manageCatalogCategories(
  actorId: string,
  input: { kind: 'suggestion'; productId: string },
): Promise<CatalogCategorySuggestion>;
export function manageCatalogCategories(
  actorId: string,
  input: { kind: 'assignment'; [key: string]: unknown },
): Promise<CatalogClassificationAssignmentResult>;
export function manageCatalogCategories(
  actorId: string,
  input: { kind: 'taxonomy'; [key: string]: unknown },
): Promise<CatalogTaxonomyResult>;
export function manageCatalogCategories(
  actorId: string,
  input: { kind: 'configure'; offset?: number },
): Promise<Extract<z.infer<typeof CategoryApiResponseSchema>, { kind: 'configure' }>>;
export function manageCatalogCategories(
  actorId: string,
  input: { kind: 'configure' | 'preview' | 'apply'; [key: string]: unknown },
): Promise<z.infer<typeof CategoryApiResponseSchema>>;
export function manageCatalogCategories(
  actorId: string,
  input: unknown,
): Promise<
  | CatalogCategorySuggestion
  | CatalogClassificationAssignmentResult
  | CatalogTaxonomyResult
  | z.infer<typeof CategoryApiResponseSchema>
>;
export async function manageCatalogCategories(
  actorId: string,
  input: unknown,
): Promise<
  | CatalogCategorySuggestion
  | CatalogClassificationAssignmentResult
  | CatalogTaxonomyResult
  | z.infer<typeof CategoryApiResponseSchema>
> {
  if (input && typeof input === 'object' && 'kind' in input && input.kind === 'suggestion') {
    return readCatalogCategorySuggestion(actorId, input);
  }
  if (input && typeof input === 'object' && 'kind' in input && input.kind === 'assignment') {
    if ('expectedSuggestion' in input) {
      const { expectedSuggestion, ...assignment } = input;
      const command = CatalogClassificationAssignmentRequestSchema.parse(assignment);
      if (!(await validateSuggestedAssignment(actorId, input))) {
        return {
          kind: 'assignment',
          results: command.products.map(({ productId }) => ({ productId, status: 'conflict' })),
        };
      }
      return manageCatalogClassificationAssignment(actorId, command, expectedSuggestion);
    }
    return manageCatalogClassificationAssignment(actorId, input);
  }
  if (input && typeof input === 'object' && 'kind' in input && input.kind === 'taxonomy') {
    const command = CatalogTaxonomyCommandSchema.parse(input);
    return CatalogTaxonomyResultSchema.parse(await manageCatalogCategory(actorId, command));
  }
  const command = CategoryApiRequestSchema.parse(input);
  const actor = await get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended')
    throw new Error('Admin permission required');
  const rules = await mappings();
  const hasDuplicate = (categoryId: string) =>
    rules
      .filter((row) => row.sourceCategoryId === categoryId)
      .some((row) => row._id !== categoryRuleId(categoryId));
  if (command.kind === 'configure') {
    const page = APPROVED_CATEGORY_RULES.slice(command.offset, command.offset + 10);
    const results = [];
    for (const rule of page) {
      try {
        const result = hasDuplicate(rule.sourceCategoryId)
          ? { status: 'conflict' }
          : await manageCatalogCategory(actorId, {
              kind: 'configure',
              sourceCategoryId: rule.sourceCategoryId,
            });
        results.push({ id: rule.sourceCategoryId, status: result.status });
      } catch {
        results.push({ id: rule.sourceCategoryId, status: 'failed' });
      }
    }
    return CategoryApiResponseSchema.parse({
      kind: 'configure',
      results,
      nextOffset:
        command.offset + page.length < APPROVED_CATEGORY_RULES.length
          ? command.offset + page.length
          : null,
    });
  }
  if (command.kind === 'preview') {
    const page = await list({
      collection: 'products',
      page: 1,
      pageSize: 100,
      sort: [{ field: '_id', dir: 'asc' }],
      ...(command.after
        ? {
            filter: {
              combinator: 'and' as const,
              clauses: [{ field: '_id', op: 'gt' as const, value: command.after }],
            },
          }
        : {}),
    });
    const now = new Date().toISOString();
    const rows = page.items.map((product) => {
      const matches = rules.filter(
        (rule) =>
          rule.sourceCategoryId === product.alibabaSourceCategoryId ||
          rule.sourceCategoryId ===
            (product.alibabaSourceReview as { sourceCategoryId?: unknown } | undefined)
              ?.sourceCategoryId,
      );
      return previewCategory(product, matches.length === 1 ? matches[0] : null, now);
    });
    return CategoryApiResponseSchema.parse({
      kind: 'preview',
      rows,
      nextAfter: page.items.length === 100 ? page.items.at(-1)?._id : null,
    });
  }
  const results = [];
  for (const item of command.commands) {
    try {
      const product = await get('products', item.productId);
      const result =
        product && hasDuplicate(String(product.alibabaSourceCategoryId ?? ''))
          ? { status: 'conflict' }
          : await manageCatalogCategory(actorId, item);
      results.push({ id: item.productId, status: result.status });
    } catch {
      results.push({ id: item.productId, status: 'failed' });
    }
  }
  return CategoryApiResponseSchema.parse({ kind: 'apply', results });
}
