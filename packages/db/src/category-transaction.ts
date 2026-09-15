/** Shared transaction body for CloudBase and the persistent local adapter. */
import { createHash } from 'node:crypto';
import { type CollectionDoc, productFamilyForDoc } from '@vibelingan-channel/shared';
import { CategoryApplySchema } from '@vibelingan-channel/shared';
import { z } from 'zod';
import {
  APPROVED_CATEGORY_RULES,
  CATEGORY_POLICY_VERSION,
  categoryRuleId,
  classificationTarget,
} from './catalog-classification.ts';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v.trim() === v);
export const CategoryCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('configure'), sourceCategoryId: id }).strict(),
  CategoryApplySchema,
]);
export interface CategoryTransaction {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  set(collection: string, row: CollectionDoc): Promise<void>;
}
export type CategoryResult = {
  status: 'configured' | 'applied' | 'replayed' | 'conflict' | 'forbidden' | 'invalid' | 'missing';
};
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, ordered(v)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
export function sourceCategoryOf(product: CollectionDoc): string {
  const review = product.alibabaSourceReview;
  const nested =
    review && typeof review === 'object' && !Array.isArray(review)
      ? (review as Record<string, unknown>).sourceCategoryId
      : undefined;
  const direct = product.alibabaSourceCategoryId;
  if (typeof direct === 'string' && typeof nested === 'string' && direct !== nested) return '';
  return typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : '';
}
function desiredRule(categoryId: string): CollectionDoc | null {
  const rule = APPROVED_CATEGORY_RULES.find((r) => r.sourceCategoryId === categoryId);
  return rule
    ? {
        _id: categoryRuleId(categoryId),
        provider: 'alibaba',
        sourceTaxonomy: 'alibaba:icbu',
        sourceCategoryId: categoryId,
        productFamily: rule.productFamily ?? '',
        reviewRequired: rule.productFamily === null,
        policyVersion: CATEGORY_POLICY_VERSION,
      }
    : null;
}
function ruleMatches(rule: CollectionDoc | null, categoryId: string): boolean {
  const desired = desiredRule(categoryId);
  return Boolean(
    rule &&
      desired &&
      [
        '_id',
        'provider',
        'sourceTaxonomy',
        'sourceCategoryId',
        'productFamily',
        'reviewRequired',
        'policyVersion',
      ].every((k) => rule[k] === desired[k]),
  );
}
export function previewCategory(
  product: CollectionDoc,
  rule: CollectionDoc | null | undefined,
  now: string,
) {
  const categoryId = sourceCategoryOf(product);
  const target = classificationTarget(categoryId, product._id);
  const base = {
    productId: product._id,
    name: typeof product.name === 'string' ? product.name : '',
    sourceCategoryId: categoryId,
    target,
  };
  if (
    product.published !== false ||
    product.archived === true ||
    productFamilyForDoc(product) !== null ||
    (product.productFamily !== undefined &&
      product.productFamily !== null &&
      product.productFamily !== '') ||
    typeof product.alibabaPrimarySourceKey !== 'string' ||
    !product.alibabaPrimarySourceKey
  )
    return { ...base, status: 'protected' as const };
  if (!target) return { ...base, status: 'deferred' as const };
  if (!ruleMatches(rule ?? null, categoryId)) return { ...base, status: 'rule-conflict' as const };
  const ruleValue: Record<string, unknown> = rule ?? {};
  const { categoryAssignmentFence: _fence, ...ruleSnapshot } = ruleValue;
  const command = {
    kind: 'apply' as const,
    productId: product._id,
    expectedDigest: digest({ product, rule: ruleSnapshot, policy: CATEGORY_POLICY_VERSION }),
    expiresAt: new Date(Date.parse(now) + 30 * 60_000).toISOString(),
  };
  return { ...base, status: 'ready' as const, command };
}

export async function runCategoryCommand(
  tx: CategoryTransaction,
  actorId: string,
  input: unknown,
  now: string,
): Promise<CategoryResult> {
  const parsed = CategoryCommandSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(Date.parse(now))) return { status: 'invalid' };
  const actor = await tx.get('users', actorId);
  if (!actor || actor.role !== 'admin' || actor.status === 'suspended')
    return { status: 'forbidden' };
  const command = parsed.data;
  if (command.kind === 'configure') {
    const desired = desiredRule(command.sourceCategoryId);
    if (!desired) return { status: 'invalid' };
    const existing = await tx.get('sourceCategoryMappings', desired._id);
    // Never replace operator decisions, including an explicitly edited policy row.
    if (existing)
      return {
        status: ruleMatches(existing, command.sourceCategoryId) ? 'configured' : 'conflict',
      };
    await tx.set('sourceCategoryMappings', {
      ...desired,
      createdAt: now,
      updatedAt: now,
      notes: `Approved website policy ${CATEGORY_POLICY_VERSION}; installed by ${actorId}`,
    });
    return { status: 'configured' };
  }
  const product = await tx.get('products', command.productId);
  if (!product) return { status: 'missing' };
  const requestDigest = digest({ actorId, command });
  const receipt = z
    .object({
      requestDigest: z.string(),
      family: z.string(),
      sourceKey: z.string(),
      sourceCategoryId: z.string(),
    })
    .passthrough()
    .safeParse(product.catalogClassificationReceipt);
  if (receipt.success && receipt.data.requestDigest === requestDigest) {
    return {
      status:
        product.productFamily === receipt.data.family &&
        product.alibabaPrimarySourceKey === receipt.data.sourceKey &&
        sourceCategoryOf(product) === receipt.data.sourceCategoryId
          ? 'replayed'
          : 'conflict',
    };
  }
  if (
    Date.parse(command.expiresAt) < Date.parse(now) ||
    Date.parse(command.expiresAt) > Date.parse(now) + 30 * 60_000
  )
    return { status: 'conflict' };
  const categoryId = sourceCategoryOf(product);
  const rule = categoryId
    ? await tx.get('sourceCategoryMappings', categoryRuleId(categoryId))
    : null;
  const preview = previewCategory(product, rule, now);
  if (preview.status !== 'ready' || preview.command.expectedDigest !== command.expectedDigest)
    return { status: 'conflict' };
  const sourceKey = String(product.alibabaPrimarySourceKey);
  const source = await tx.get('alibabaSourceProducts', sourceKey);
  const link = await tx.get('alibabaProductLinks', sourceKey);
  if (
    !source ||
    source.active !== true ||
    source.sourceCategoryId !== categoryId ||
    link?.productId !== product._id
  )
    return { status: 'conflict' };
  if (!rule) return { status: 'conflict' };
  // Snapshot reads alone do not serialize concurrent source/link/rule changes.
  // Fence these dependencies in the same transaction; failure aborts all writes.
  for (const [collection, row] of [
    ['sourceCategoryMappings', rule],
    ['alibabaSourceProducts', source],
    ['alibabaProductLinks', link],
  ] as const) {
    await tx.set(collection, { ...row, categoryAssignmentFence: command.operationId });
  }
  await tx.set('products', {
    ...product,
    productFamily: preview.target,
    category: '',
    alibabaClassifiedCategoryId: categoryId,
    catalogClassificationReceipt: {
      requestDigest,
      operationId: command.operationId,
      policyVersion: CATEGORY_POLICY_VERSION,
      actorId,
      at: now,
      family: preview.target,
      sourceKey,
      sourceCategoryId: categoryId,
    },
    updatedAt: now,
  });
  return { status: 'applied' };
}
