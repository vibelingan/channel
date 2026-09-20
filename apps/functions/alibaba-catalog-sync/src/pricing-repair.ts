/** Whole-catalog audit and price-only repair. No supplier calls or publication. */
import { randomUUID } from 'node:crypto';
import {
  type AlibabaCatalogPricing,
  type OfferForSelection,
  PRODUCT_LEVEL_SKU_SENTINEL,
  selectPrimaryOffer,
  validateAlibabaCatalogPricing,
} from '@vibelingan-channel/alibaba-catalog-sync';
import {
  ALIBABA_SYNC_LEASE_TTL_MS,
  type AlibabaLeaseGuard,
  type AlibabaPricingEvidenceExpectation,
  type AlibabaProductLinkIdentity,
  type AlibabaProductMutationInput,
  acquireAlibabaSyncLease,
  alibabaPricingFingerprint as fingerprint,
  get,
  list,
  mutateAlibabaProduct,
  releaseAlibabaSyncLease,
  renewAlibabaSyncLease,
} from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  createAlibabaPricingAdapter,
  resolveManualCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import { z } from 'zod';
import { snapshotAlibabaProductIdentity } from './linking.ts';
import { listAllDocs } from './list-all.ts';

export const PricingRepairInputSchema = z
  .object({
    afterId: z.string().min(1).max(200).optional(),
    mode: z.enum(['dry-run', 'apply']).optional(),
    expectedPageHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.mode === 'apply') !== (input.expectedPageHash !== undefined))
      context.addIssue({ code: 'custom', message: 'Apply requires the dry-run page hash.' });
  });
type Status =
  | 'archived'
  | 'unlinked'
  | 'manual'
  | 'invalid-manual'
  | 'valid-source'
  | 'stale-source'
  | 'eligible'
  | 'quote-only'
  | 'invalid-source'
  | 'incomplete-run'
  | 'invalid-pin'
  | 'invalid-offer'
  | 'identity-conflict'
  | 'error'
  | 'repaired'
  | 'conflict';
export interface PricingRepairOutcome {
  productId: string;
  status: Status;
  reason: string;
  inputHash: string;
  protectedHash: string;
  sourceKey?: string;
  sourceProductId?: string;
  expectedRevision?: number;
  expectedLinks?: AlibabaProductLinkIdentity[];
  offerSetHash?: string;
  evidence?: AlibabaPricingEvidenceExpectation[];
  proposedHash?: string;
  proposedPricing?: AlibabaCatalogPricing;
}
export type PricingMaterializationOutcome = Pick<
  PricingRepairOutcome,
  'productId' | 'status' | 'reason'
>;

type RepairWrite = Omit<
  Extract<AlibabaProductMutationInput, { action: 'repair-pricing' }>,
  'guard' | 'now'
>;
type Planned = { outcome: PricingRepairOutcome; write?: RepairWrite };
const internalFields = new Set([
  'alibabaCatalogPricing',
  'alibabaPrimaryOfferKey',
  'alibabaLinkRevision',
  'updatedAt',
]);
export const protectedPricingFieldsHash = (product: CollectionDoc) =>
  fingerprint(
    Object.fromEntries(Object.entries(product).filter(([key]) => !internalFields.has(key))),
  );
const amountBearing = (pricing: AlibabaCatalogPricing) =>
  ['fixed', 'range', 'tiered'].includes(pricing.mode);
const now = () => new Date().toISOString();

/** Bind the original product; never substitute the product now found by sourceKey. */
export async function planProductPricingRepair(product: CollectionDoc): Promise<Planned> {
  const base = {
    productId: product._id,
    inputHash: fingerprint(product),
    protectedHash: protectedPricingFieldsHash(product),
  };
  const result = (
    status: Status,
    reason: string,
    extra: Partial<PricingRepairOutcome> = {},
  ): Planned => ({ outcome: { ...base, status, reason, ...extra } });
  if (product.archived === true) return result('archived', 'Archived product; no write.');
  const manual = resolveManualCatalogPricing({
    ...product,
    catalogPricingMode: product.catalogPricingMode,
  });
  if (manual.source === 'scalar' || manual.source === 'manual-tiered')
    return result('manual', 'Website pricing is authoritative.');
  if (manual.source !== 'inherit')
    return result('invalid-manual', 'Explicit or invalid manual pricing requires operator review.');
  if (
    product.catalogPricingMode !== 'source' &&
    Object.hasOwn(product, 'manualCatalogPricing') &&
    product.manualCatalogPricing != null
  )
    return result('invalid-manual', 'Invalid manual pricing requires operator review.');
  const sourceKey = product.alibabaPrimarySourceKey;
  if (typeof sourceKey !== 'string' || !sourceKey.trim())
    return result('unlinked', 'No primary Alibaba source.');
  const snapshot = await snapshotAlibabaProductIdentity(product);
  if (!snapshot.ok) return result('identity-conflict', snapshot.reason, { sourceKey });
  const link = snapshot.expectation.expectedLinks.find((row) => row._id === sourceKey);
  const source = await get('alibabaSourceProducts', sourceKey);
  if (
    !source ||
    source.active !== true ||
    source.connectionId !== 'primary' ||
    typeof source.sourceProductId !== 'string'
  )
    return result(
      'invalid-source',
      'Source is missing, inactive, or belongs to another connection.',
      { sourceKey },
    );
  if (
    !link ||
    link.productId !== product._id ||
    link.connectionId !== source.connectionId ||
    link.sourceProductId !== source.sourceProductId
  )
    return result(
      'identity-conflict',
      'Product, source and link do not identify the same record.',
      { sourceKey },
    );
  const sourceFields = {
    sourceKey,
    sourceProductId: source.sourceProductId,
    expectedRevision: snapshot.expectation.expectedRevision ?? 0,
    expectedLinks: snapshot.expectation.expectedLinks,
  };
  const evidence: AlibabaPricingEvidenceExpectation[] = [
    { collection: 'alibabaSourceProducts', id: sourceKey, hash: fingerprint(source) },
  ];
  const runIds = new Set<string>();
  const acceptRun = async (id: unknown) => {
    if (typeof id !== 'string' || !id) return false;
    if (runIds.has(id)) return true;
    const run = await get('alibabaSyncRuns', id);
    if (!run || run.status !== 'completed') return false;
    runIds.add(id);
    evidence.push({ collection: 'alibabaSyncRuns', id, hash: fingerprint(run) });
    return true;
  };
  if (
    !(await acceptRun(source.lastSeenRunId)) ||
    (source.lastChangedRunId !== undefined && !(await acceptRun(source.lastChangedRunId)))
  )
    return result(
      'incomplete-run',
      'Source provenance is not a completed clean run.',
      sourceFields,
    );
  const rows = await listAllDocs('alibabaSupplierOffers', [
    { field: 'sourceKey', op: 'eq', value: sourceKey },
  ]);
  const offerSetHash = fingerprint(rows);
  const candidates: OfferForSelection[] = [];
  for (const row of rows.filter((row) => row.active === true)) {
    const parsed = validateAlibabaCatalogPricing(row.pricing);
    if (
      !parsed.ok ||
      typeof row.sourceSkuId !== 'string' ||
      parsed.value.sourceOfferKey !== row._id ||
      parsed.value.sourceProductId !== source.sourceProductId ||
      (parsed.value.sourceSkuId ?? PRODUCT_LEVEL_SKU_SENTINEL) !== row.sourceSkuId ||
      (row.sourceProductId !== undefined && row.sourceProductId !== source.sourceProductId)
    )
      return result(
        'invalid-offer',
        'An active offer has invalid pricing or mismatched provenance.',
        { ...sourceFields, offerSetHash },
      );
    const publicQuote = Object.fromEntries(
      Object.entries(parsed.value).filter(
        ([key]) => !['sourceOfferKey', 'sourceProductId', 'sourceSkuId'].includes(key),
      ),
    );
    if (
      amountBearing(parsed.value) &&
      createAlibabaPricingAdapter().resolve(sourceKey, publicQuote).state !== 'available'
    )
      return result(
        'invalid-offer',
        'Source quote cannot be represented by the public pricing contract.',
        { ...sourceFields, offerSetHash },
      );
    if (!(await acceptRun(row.lastSeenRunId)))
      return result('incomplete-run', 'An active offer does not have completed run provenance.', {
        ...sourceFields,
        offerSetHash,
      });
    candidates.push({
      offerKey: row._id,
      sourceKey,
      sourceSkuId: row.sourceSkuId,
      active: true,
      pricing: parsed.value,
    });
  }
  const pin = product.alibabaPinnedOfferKey;
  if (
    pin != null &&
    pin !== '' &&
    (typeof pin !== 'string' || !candidates.some((offer) => offer.offerKey === pin))
  )
    return result(
      'invalid-pin',
      'Pinned offer is missing or inactive; do not silently select another SKU.',
      sourceFields,
    );
  const selected = selectPrimaryOffer(candidates, typeof pin === 'string' ? pin : undefined);
  if (!selected || !amountBearing(selected.pricing))
    return result(
      'quote-only',
      selected ? `Source quote is ${selected.pricing.mode}.` : 'No active numeric source quote.',
      { ...sourceFields, offerSetHash },
    );
  const selectedRow = rows.find((row) => row._id === selected.offerKey);
  if (!selectedRow) throw new Error('Selected quote disappeared');
  evidence.push({
    collection: 'alibabaSupplierOffers',
    id: selectedRow._id,
    hash: fingerprint(selectedRow),
  });
  if (evidence.length > 48)
    return result(
      'invalid-offer',
      'Evidence exceeds the bounded transaction budget; review required.',
      sourceFields,
    );
  const patch = {
    alibabaPrimaryOfferKey: selected.offerKey,
    alibabaCatalogPricing: selected.pricing,
  };
  const extra = {
    ...sourceFields,
    offerSetHash,
    evidence,
    proposedPricing: selected.pricing,
    proposedHash: fingerprint(patch),
  };
  const current = validateAlibabaCatalogPricing(product.alibabaCatalogPricing);
  if (current.ok && amountBearing(current.value)) {
    const withoutClock = (pricing: AlibabaCatalogPricing) => {
      const { syncedAt: _clock, ...rest } = pricing;
      return rest;
    };
    return fingerprint(withoutClock(current.value)) === fingerprint(withoutClock(selected.pricing))
      ? result('valid-source', 'Source pricing is already correct.', extra)
      : result(
          'stale-source',
          'Existing numeric price differs from current source; review before repricing.',
          extra,
        );
  }
  return {
    outcome: {
      ...base,
      ...extra,
      status: 'eligible',
      reason: Object.hasOwn(product, 'alibabaCatalogPricing')
        ? 'Invalid, null or unavailable summary; valid source quote exists.'
        : 'Price summary absent; valid source quote exists.',
    },
    write: {
      ...snapshot.expectation,
      action: 'repair-pricing',
      sourceKey,
      expectedProductHash: base.inputHash,
      expectedEvidence: evidence,
      patch,
    },
  };
}

async function withPricingLease<T>(
  operation: (guard: () => Promise<AlibabaLeaseGuard>) => Promise<T>,
  onReleaseFailure?: (result: T) => T,
): Promise<T> {
  const holder = `pricing-repair-${randomUUID()}`;
  const lease = await acquireAlibabaSyncLease('primary', holder, now(), ALIBABA_SYNC_LEASE_TTL_MS);
  if (lease.result !== 'granted')
    throw new Error(`Pricing repair cannot start: lease ${lease.result}.`);
  let completion: { ok: true; result: T } | { ok: false; error: unknown };
  try {
    const result = await operation(async () => {
      if (
        !(await renewAlibabaSyncLease(
          'primary',
          holder,
          lease.fence,
          now(),
          ALIBABA_SYNC_LEASE_TTL_MS,
        ))
      )
        throw new Error('Pricing repair lost the sync lease. Re-audit this page.');
      return { connectionId: 'primary', holder, fence: lease.fence, now: now() };
    });
    completion = { ok: true, result };
  } catch (error) {
    completion = { ok: false, error };
  }
  let released: boolean;
  try {
    released = await releaseAlibabaSyncLease('primary', holder, lease.fence, now());
  } catch {
    released = false;
  }
  if (!released) {
    if (completion.ok && onReleaseFailure) return onReleaseFailure(completion.result);
    throw new Error('Pricing repair lease release unconfirmed; re-audit before retrying.');
  }
  if (!completion.ok) throw completion.error;
  return completion.result;
}

/** Called after a requested link/catch-up, using the same pricing owner as historical repair. */
async function verifyPricingReadback(outcome: PricingRepairOutcome, revision: number) {
  const after = await get('products', outcome.productId);
  if (
    !after ||
    after.alibabaLinkRevision !== revision ||
    protectedPricingFieldsHash(after) !== outcome.protectedHash ||
    fingerprint({
      alibabaCatalogPricing: after.alibabaCatalogPricing,
      alibabaPrimaryOfferKey: after.alibabaPrimaryOfferKey,
    }) !== outcome.proposedHash
  )
    throw new Error(
      'Pricing repair acknowledgement is unconfirmed; re-audit this product before retrying.',
    );
}

export async function materializeCompletedProductPricing(
  productId: string,
): Promise<PricingMaterializationOutcome> {
  const summary = ({ productId, status, reason }: PricingMaterializationOutcome) => ({
    productId,
    status,
    reason,
  });
  try {
    const product = await get('products', productId);
    if (!product) throw new Error('Linked product is missing');
    const plan = await planProductPricingRepair(product);
    if (!plan.write) return summary(plan.outcome);
    return await withPricingLease(async (guard) => {
      const current = await get('products', productId);
      if (!current || fingerprint(current) !== plan.outcome.inputHash)
        return summary({ productId, status: 'conflict', reason: 'Product changed after linking.' });
      const fresh = await planProductPricingRepair(current);
      if (!fresh.write || fingerprint(fresh.outcome) !== fingerprint(plan.outcome))
        return summary({ productId, status: 'conflict', reason: 'Source changed after linking.' });
      const result = await mutateAlibabaProduct({
        ...fresh.write,
        guard: await guard(),
        now: now(),
      });
      if (result.ok) await verifyPricingReadback(fresh.outcome, result.revision);
      return summary({
        productId,
        status: result.ok ? 'repaired' : 'conflict',
        reason: result.ok ? 'Completed quote materialized and verified.' : result.reason,
      });
    });
  } catch {
    // Linking/draft creation already succeeded. Preserve that result and report price uncertainty.
    return {
      productId,
      status: 'error',
      reason: 'Price materialization unconfirmed; run the pricing audit before retrying.',
    };
  }
}

export async function repairMissingSourcePricing(input: z.infer<typeof PricingRepairInputSchema>) {
  const parsed = PricingRepairInputSchema.parse(input);
  const mode = parsed.mode ?? 'dry-run';
  const execute = async (guard?: () => Promise<AlibabaLeaseGuard>) => {
    const page = await list({
      collection: 'products',
      page: 1,
      pageSize: 20,
      sort: [{ field: '_id', dir: 'asc' }],
      ...(parsed.afterId
        ? {
            filter: {
              combinator: 'and' as const,
              clauses: [{ field: '_id', op: 'gt' as const, value: parsed.afterId }],
            },
          }
        : {}),
    });
    const plans: Planned[] = [];
    for (const product of page.items) {
      if (guard) await guard();
      try {
        plans.push(await planProductPricingRepair(product));
      } catch {
        plans.push({
          outcome: {
            productId: product._id,
            status: 'error',
            reason: 'Evidence read failed; re-audit this page.',
            inputHash: fingerprint(product),
            protectedHash: protectedPricingFieldsHash(product),
          },
        });
      }
    }
    const pageHash = fingerprint({
      afterId: parsed.afterId ?? null,
      outcomes: plans.map((plan) => plan.outcome),
    });
    const outcomes = plans.map((plan) => ({ ...plan.outcome }));
    let stopped: string | null = outcomes.some((row) => row.status === 'error')
      ? 'evidence-read-failed'
      : null;
    if (mode === 'apply' && pageHash !== parsed.expectedPageHash) stopped = 'page-changed';
    let repaired = 0;
    if (mode === 'apply' && !stopped && guard) {
      for (const [index, plan] of plans.entries()) {
        if (!plan.write) continue;
        try {
          const result = await mutateAlibabaProduct({
            ...plan.write,
            guard: await guard(),
            now: now(),
          });
          if (!result.ok) {
            outcomes[index] = { ...plan.outcome, status: 'conflict', reason: result.reason };
            stopped = result.reason;
            break;
          }
          await verifyPricingReadback(plan.outcome, result.revision);
          outcomes[index] = {
            ...plan.outcome,
            status: 'repaired',
            reason: 'Price-only write verified.',
          };
          repaired++;
        } catch {
          outcomes[index] = {
            ...plan.outcome,
            status: 'error',
            reason: 'Price repair unconfirmed; re-audit this product before retrying.',
          };
          stopped = 'write-unconfirmed';
          break;
        }
      }
    }
    const deferred = outcomes
      .filter(
        (row) =>
          ![
            'archived',
            'unlinked',
            'manual',
            'valid-source',
            'eligible',
            'quote-only',
            'repaired',
          ].includes(row.status),
      )
      .map((row) => row.productId);
    return {
      mode,
      visited: page.items.length,
      eligible: plans.filter((plan) => plan.write).length,
      repaired,
      deferred,
      pageHash,
      outcomes,
      stopped,
      nextId: page.items.length === 20 ? (page.items.at(-1)?._id ?? null) : null,
    };
  };
  // Audit does not acquire a lease or write a manifest collection.
  return mode === 'apply'
    ? withPricingLease(execute, (page) => ({
        ...page,
        stopped: page.stopped
          ? `${page.stopped};lease-release-unconfirmed`
          : 'lease-release-unconfirmed',
      }))
    : execute();
}
