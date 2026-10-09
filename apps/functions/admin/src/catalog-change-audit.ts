/**
 * One-time "changed since approval" audit (MIU-38, runbook R6). Approvals made
 * before source fingerprints existed have no baseline, so a sync can never flag
 * them. For each such product, plan builds what an approval would produce today
 * from the stored observation (same builder and configuration ids as a real
 * approval, no staging writes) and compares it with the approved version on
 * what both sides take from the source (DEC-6): configurations, their prices
 * and options, the product-level price and facts. Not the description (the
 * approved text is the admin's) or images (ids versus URLs).
 *
 * Apply re-plans each reviewed row on the server and writes through the
 * `change-audit-mark` command (MIU-22): "unchanged" records the baseline
 * digest, "changed" flags the product for review.
 */
import { buildCatalogDetailCandidate } from '@vibelingan-channel/catalog-import/detail-candidate';
import { validateCatalogSourceObservation } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  CatalogDetailVariantSchema,
} from '@vibelingan-channel/shared/catalog-detail';
import { publicSourceDigest } from '@vibelingan-channel/shared/catalog-source-digest';
import type { z } from 'zod';
import { catalogCategoryLabel, sourceVariantIds } from './catalog-detail-source.ts';

export interface ChangeAuditReader {
  /** Products ordered by `_id`, strictly after `afterId`. */
  listProducts(afterId: string | undefined, pageSize: number): Promise<CollectionDoc[]>;
  getProduct(id: string): Promise<CollectionDoc | null>;
  /** Every approved configuration row of one revision. */
  listApprovedVariants(
    productId: string,
    revision: string,
    storage: 'immutable-v1' | 'legacy',
  ): Promise<CollectionDoc[]>;
  /** The stored observation of a source (raw), or null. */
  getObservation(sourceKey: string): Promise<unknown>;
}

export type ChangeAuditSkip =
  | 'unlinked'
  | 'archived'
  | 'not-approved'
  | 'already-present'
  | 'no-observation'
  | 'invalid-variant-rows';

export type ChangeAuditRow =
  | { productId: string; revision: string; outcome: 'unchanged'; sourceDigest: string }
  | {
      productId: string;
      revision: string;
      outcome: 'changed';
      sourceDigest: string;
      differences: string[];
    }
  | { productId: string; outcome: 'skipped'; reason: ChangeAuditSkip };

/** Key-order-independent JSON, so stored and freshly built objects compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

type Offer = { kind?: unknown; pricing?: unknown };
/** Offers by kind and price only; their order and other labels are not content. */
const offerSet = (offers: readonly Offer[] | undefined) =>
  (offers ?? [])
    .map((offer) => canonical([offer.kind, offer.pricing]))
    .sort()
    .join('|');

type Variant = z.infer<typeof CatalogDetailVariantSchema>;
type Publication = z.infer<typeof CatalogDetailPublicationSchema>;
type Observation = Extract<
  ReturnType<typeof validateCatalogSourceObservation>,
  { ok: true }
>['value'];

/**
 * What an approval would take from the supplier now, against the approved
 * version, on what both sides take from the source (DEC-6): configurations,
 * their prices and options, the product-level price and facts. Shared by the
 * one-time audit and the admin's supplier review (DEC-19).
 */
type Pricing = Variant['offers'][number]['pricing'];
type Fact = Publication['header']['facts'][number];
export interface ApprovedComparison {
  configurationsAdded: string[];
  configurationsRemoved: string[];
  prices: Array<{ configuration: string; before: Pricing[]; after: Pricing[] }>;
  options: string[];
  productPrice?: { before: Pricing[]; after: Pricing[] };
  facts?: { before: Fact[]; after: Fact[] };
}

const variantLabel = (variant: { options: readonly { value: unknown }[] }) =>
  variant.options.map((option) => String(option.value)).join(' / ') || 'default';
const pricings = (offers: readonly { pricing: Pricing }[]) => offers.map((offer) => offer.pricing);

export async function compareWithApproved(
  reader: Pick<ChangeAuditReader, 'listApprovedVariants'>,
  product: CollectionDoc,
  sourceKey: string,
  observation: Observation,
  publication: Publication,
): Promise<ApprovedComparison | 'invalid-variant-rows' | 'no-observation'> {
  const { revision, header, variantCount } = publication;
  const storage = publication.variantStorage === 'immutable-v1' ? 'immutable-v1' : 'legacy';
  const approved = (await reader.listApprovedVariants(product._id, revision, storage)).map((row) =>
    CatalogDetailVariantSchema.safeParse(row.catalogDetailApproved),
  );
  if (approved.length !== variantCount || approved.some((row) => !row.success))
    return 'invalid-variant-rows';
  // What an approval would build today, every configuration page.
  const bindings = {
    productId: product._id,
    variants: sourceVariantIds(product._id, sourceKey, observation),
    images: new Map<string, string>(),
    ...catalogCategoryLabel(product.productFamily),
  };
  const first = buildCatalogDetailCandidate(observation, bindings, 1, 50);
  if (!first.ok) return 'no-observation';
  const candidateVariants: Variant[] = [...first.value.variants.items];
  for (let page = 2; candidateVariants.length < first.value.variants.total; page++) {
    const next = buildCatalogDetailCandidate(observation, bindings, page, 50);
    if (!next.ok || next.value.variants.items.length === 0) return 'no-observation';
    candidateVariants.push(...next.value.variants.items);
  }
  const before = new Map(
    approved.flatMap((row) => (row.success ? [[row.data.id, row.data] as const] : [])),
  );
  const after = new Map(candidateVariants.map((variant) => [variant.id, variant]));
  const comparison: ApprovedComparison = {
    configurationsAdded: [...after.values()]
      .filter((variant) => !before.has(variant.id))
      .map(variantLabel),
    configurationsRemoved: [...before.values()]
      .filter((variant) => !after.has(variant.id))
      .map(variantLabel),
    prices: [],
    options: [],
  };
  for (const [id, was] of before) {
    const now = after.get(id);
    if (!now) continue;
    if (offerSet(was.offers) !== offerSet(now.offers))
      comparison.prices.push({
        configuration: variantLabel(was),
        before: pricings(was.offers),
        after: pricings(now.offers),
      });
    if (canonical(was.options) !== canonical(now.options))
      comparison.options.push(variantLabel(was));
  }
  if (offerSet(header.offers) !== offerSet(first.value.offers))
    comparison.productPrice = {
      before: pricings(header.offers),
      after: pricings(first.value.offers),
    };
  if (canonical(header.facts) !== canonical(first.value.facts))
    comparison.facts = { before: header.facts, after: first.value.facts };
  // Not compared: the description (the approved text is the admin's own, from
  // the row) and images (approved rows hold image ids, the source holds URLs);
  // the supplier review compares those parts separately.
  return comparison;
}

/** The audit's one-line differences, in a stable order. */
function differenceLabels(comparison: ApprovedComparison): string[] {
  const labels: string[] = [];
  if (comparison.configurationsAdded.length) labels.push('configurations added');
  if (comparison.configurationsRemoved.length) labels.push('configurations removed');
  const priced = new Set(comparison.prices.map((entry) => entry.configuration));
  const optioned = new Set(comparison.options);
  for (const label of [...new Set([...priced, ...optioned])]) {
    if (priced.has(label)) labels.push(`configuration ${label}: price`);
    if (optioned.has(label)) labels.push(`configuration ${label}: options`);
  }
  if (comparison.productPrice) labels.push('product price');
  if (comparison.facts) labels.push('facts');
  return labels;
}

export async function planProductChange(
  reader: ChangeAuditReader,
  product: CollectionDoc,
): Promise<ChangeAuditRow> {
  const skip = (reason: ChangeAuditSkip): ChangeAuditRow => ({
    productId: product._id,
    outcome: 'skipped',
    reason,
  });
  const sourceKey = product.alibabaPrimarySourceKey;
  if (typeof sourceKey !== 'string' || sourceKey === '') return skip('unlinked');
  if (product.archived === true) return skip('archived');
  const publication = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  if (!publication.success || publication.data.header._id !== product._id)
    return skip('not-approved');
  const receipt = product.catalogDetailApprovalReceipt;
  if (
    receipt &&
    typeof receipt === 'object' &&
    typeof Reflect.get(receipt, 'sourceDigest') === 'string'
  )
    return skip('already-present');
  const valid = validateCatalogSourceObservation(await reader.getObservation(sourceKey));
  if (
    !valid.ok ||
    valid.value.source.completeness !== 'full-product' ||
    valid.value.source.provider !== 'alibaba' ||
    valid.value.source.sourceProductKey !== sourceKey
  )
    return skip('no-observation');
  const comparison = await compareWithApproved(
    reader,
    product,
    sourceKey,
    valid.value,
    publication.data,
  );
  if (typeof comparison === 'string') return skip(comparison);
  const differences = differenceLabels(comparison);
  const { revision } = publication.data;
  const sourceDigest = publicSourceDigest(valid.value);
  return differences.length > 0
    ? { productId: product._id, revision, outcome: 'changed', sourceDigest, differences }
    : { productId: product._id, revision, outcome: 'unchanged', sourceDigest };
}

/** Read-only. Never writes; reviewed rows go to `applyChangeAudit`. */
export async function planChangeAudit(
  reader: ChangeAuditReader,
  input: { afterId?: string; pageSize: number },
) {
  const pageSize = Math.max(1, Math.min(20, Math.trunc(input.pageSize)));
  const products = await reader.listProducts(input.afterId, pageSize);
  const rows: ChangeAuditRow[] = [];
  for (const product of products) rows.push(await planProductChange(reader, product));
  return {
    rows,
    nextAfterId: products.at(-1)?._id ?? input.afterId,
    done: products.length < pageSize,
  };
}

export interface ChangeAuditApplyRow {
  productId: string;
  revision: string;
  outcome: 'unchanged' | 'changed';
}

/**
 * The server, not the caller, decides: each reviewed row is re-planned and
 * written only when the plan still says the same thing about the same revision.
 */
export async function applyChangeAudit(
  reader: ChangeAuditReader,
  persist: (command: unknown) => Promise<unknown>,
  rows: readonly ChangeAuditApplyRow[],
) {
  const results: Array<{ productId: string; result: unknown }> = [];
  const skipped = (reason: string) => ({ ok: true, backfill: 'skipped', reason });
  for (const row of rows) {
    const product = await reader.getProduct(row.productId);
    const planned = product ? await planProductChange(reader, product) : undefined;
    if (planned?.outcome === 'skipped') {
      results.push({ productId: row.productId, result: skipped(planned.reason) });
      continue;
    }
    if (!planned || planned.revision !== row.revision || planned.outcome !== row.outcome) {
      results.push({ productId: row.productId, result: skipped('plan-changed') });
      continue;
    }
    results.push({
      productId: row.productId,
      result: await persist({
        action: 'change-audit-mark',
        productId: row.productId,
        revision: planned.revision,
        outcome: planned.outcome,
        sourceDigest: planned.sourceDigest,
      }),
    });
  }
  return results;
}
