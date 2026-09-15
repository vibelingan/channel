/**
 * Quarantine approval (ARCHITECTURE §12, R1 E4).
 *
 * Approval promotes the FROZEN candidate set of a quarantined run — nothing
 * else. Immutability is enforced by recomputing the candidate hash from the
 * current mirror and comparing it to the hash stored at quarantine time: any
 * newer run that touched the mirror changes the hash and the approval is
 * rejected as superseded. Tombstone sets are NEVER applied through approval —
 * a fresh full run must re-derive and re-confirm them.
 */
import {
  type AlibabaCatalogPricing,
  buildPromotionCandidate,
  computeCandidateHash,
} from '@vibelingan-channel/alibaba-catalog-sync';
import {
  ALIBABA_SYNC_LEASE_TTL_MS,
  type AlibabaProductMutationInput,
  acquireAlibabaSyncLease,
  mutateAlibabaProduct,
  releaseAlibabaSyncLease,
} from '@vibelingan-channel/db';
import type { AlertSender } from './alerts.ts';
import {
  buildAlibabaSourceReview,
  loadAlibabaObservation,
  snapshotAlibabaProductIdentity,
} from './linking.ts';
import { listAllDocs } from './list-all.ts';
import { PRIMARY_CONNECTION_ID } from './oauth.ts';
import { getDoc, updateDocWithAlibabaLease } from './repo.ts';

export interface ApproveInput {
  runId: string;
  candidateHash: string;
  approvedByUserId: string;
  now: () => string;
  alert: AlertSender;
}

export type ApproveResult =
  | { ok: true; runId: string; promoted: number }
  | {
      ok: false;
      reason:
        | 'run-not-found'
        | 'not-quarantined'
        | 'superseded'
        | 'lease-busy'
        | 'promotion-rejected';
    };

export interface QuarantineCandidate {
  sourceKey: string;
  expectation: Pick<
    AlibabaProductMutationInput,
    'productId' | 'expectedRevision' | 'expectedPrimarySourceKey' | 'expectedLinks'
  > | null;
}

export async function snapshotQuarantineCandidate(sourceKey: string): Promise<QuarantineCandidate> {
  const link = await getDoc('alibabaProductLinks', sourceKey);
  const product =
    typeof link?.productId === 'string' && link.productId !== ''
      ? await getDoc('products', link.productId)
      : null;
  if (!product) return { sourceKey, expectation: null };
  const snapshot = await snapshotAlibabaProductIdentity(product);
  return { sourceKey, expectation: snapshot.ok ? snapshot.expectation : null };
}

export function computeQuarantineCandidateHash(input: {
  runId: string;
  candidates: QuarantineCandidate[];
  tombstones: string[];
}): string {
  return computeCandidateHash({ schemaVersion: 'alibaba-quarantine-identity-v2', ...input });
}

async function recomputeCandidates(runId: string, mode: string) {
  // Must reproduce the runner's set EXACTLY — both sides now use the same
  // complete cursor walk, or the frozen candidate hash can never match.
  const seen = await listAllDocs('alibabaSourceProducts', [
    { field: 'lastSeenRunId', op: 'eq', value: runId },
  ]);
  const candidates: QuarantineCandidate[] = [];
  for (const source of seen) {
    const link = await getDoc('alibabaProductLinks', source._id);
    if (link && typeof link.productId === 'string' && link.productId !== '') {
      candidates.push(await snapshotQuarantineCandidate(source._id));
    }
  }
  // MODE-AWARE (review R2 #6): incremental runs freeze an EMPTY tombstone set
  // (they never tombstone); recomputing one here would make every quarantined
  // incremental run permanently unapprovable. Ids only — stable under stamps.
  let tombstones: string[] = [];
  if (mode === 'full') {
    const active = await listAllDocs('alibabaSourceProducts', [
      { field: 'active', op: 'eq', value: true },
    ]);
    tombstones = active.filter((doc) => doc.lastSeenRunId !== runId).map((doc) => doc._id);
  }
  return { candidates, tombstones };
}

export async function approveQuarantinedRun(input: ApproveInput): Promise<ApproveResult> {
  const now = input.now();
  const holder = `approve-${input.runId}`;
  const grant = await acquireAlibabaSyncLease(
    PRIMARY_CONNECTION_ID,
    holder,
    now,
    ALIBABA_SYNC_LEASE_TTL_MS,
  );
  if (grant.result !== 'granted') return { ok: false, reason: 'lease-busy' };
  try {
    const run = await getDoc('alibabaSyncRuns', input.runId);
    if (!run) return { ok: false, reason: 'run-not-found' };
    if (run.status !== 'quarantined') return { ok: false, reason: 'not-quarantined' };
    const { candidates, tombstones } = await recomputeCandidates(
      input.runId,
      String(run.mode ?? ''),
    );
    const recomputedHash = computeQuarantineCandidateHash({
      runId: input.runId,
      candidates,
      tombstones,
    });
    if (
      recomputedHash !== run.candidateHash ||
      input.candidateHash !== run.candidateHash ||
      candidates.some((candidate) => candidate.expectation === null)
    ) {
      return { ok: false, reason: 'superseded' };
    }
    let promoted = 0;
    for (const candidate of candidates) {
      if (!candidate.expectation) return { ok: false, reason: 'superseded' };
      if (candidate.sourceKey !== candidate.expectation.expectedPrimarySourceKey) continue;
      const product = await getDoc('products', candidate.expectation.productId);
      if (!product) return { ok: false, reason: 'superseded' };
      const source = await getDoc('alibabaSourceProducts', candidate.sourceKey);
      if (!source) return { ok: false, reason: 'superseded' };
      const observation = await loadAlibabaObservation(source);
      const offers = await listAllDocs('alibabaSupplierOffers', [
        { field: 'sourceKey', op: 'eq', value: candidate.sourceKey },
      ]);
      const promotionNow = input.now();
      const promotion = buildPromotionCandidate({
        sourceKey: candidate.sourceKey,
        offers: offers.map((offer) => ({
          offerKey: offer._id,
          sourceKey: String(offer.sourceKey ?? ''),
          sourceSkuId: String(offer.sourceSkuId ?? ''),
          active: offer.active === true,
          pricing: offer.pricing as AlibabaCatalogPricing,
          ...(typeof offer.sourceAvailability === 'number'
            ? { sourceAvailability: offer.sourceAvailability }
            : {}),
        })),
        source: { active: source.active === true },
        ...(typeof product.alibabaPinnedOfferKey === 'string' &&
        product.alibabaPinnedOfferKey !== ''
          ? { pinnedOfferKey: product.alibabaPinnedOfferKey }
          : {}),
        now: promotionNow,
      });
      const patch = {
        ...promotion.patch,
        alibabaDescriptionImageUrls: observation?.content.description?.imageUrls ?? [],
        ...(observation === null
          ? {}
          : { alibabaSourceReview: buildAlibabaSourceReview(observation) }),
        alibabaSourceProductId: String(source.sourceProductId ?? ''),
        alibabaSourceCategoryId: String(source.sourceCategoryId ?? ''),
        alibabaSourceImageUrls: Array.isArray(source.sourceImageUrls)
          ? source.sourceImageUrls.filter((value): value is string => typeof value === 'string')
          : [],
      };
      const changed = (
        [
          'alibabaCatalogPricing',
          'alibabaPrimaryOfferKey',
          'alibabaSourceStatus',
          'alibabaSourceProductId',
          'alibabaSourceCategoryId',
          'alibabaSourceImageUrls',
          'alibabaDescriptionImageUrls',
          'alibabaSourceReview',
        ] as const
      ).some(
        (field) =>
          computeCandidateHash(product[field] ?? null) !==
          computeCandidateHash(patch[field] ?? null),
      );
      const result = await mutateAlibabaProduct({
        ...candidate.expectation,
        action: 'promote',
        sourceKey: candidate.sourceKey,
        patch,
        guard: {
          connectionId: PRIMARY_CONNECTION_ID,
          holder,
          fence: grant.fence,
          now: promotionNow,
        },
        now: promotionNow,
      });
      if (!result.ok) {
        return {
          ok: false,
          reason:
            result.reason === 'fence-rejected'
              ? 'lease-busy'
              : result.reason === 'identity-conflict' || result.reason === 'source-linked-elsewhere'
                ? 'superseded'
                : 'promotion-rejected',
        };
      }
      if (changed) promoted += 1;
    }
    const approved = await updateDocWithAlibabaLease(
      'alibabaSyncRuns',
      input.runId,
      {
        status: 'approved',
        approval: {
          approvedByUserId: input.approvedByUserId,
          approvedAt: input.now(),
          candidateHash: run.candidateHash,
          reason: 'operator-approved',
        },
      },
      {
        connectionId: PRIMARY_CONNECTION_ID,
        holder,
        fence: grant.fence,
        now: input.now(),
      },
    );
    if (!approved) return { ok: false, reason: 'lease-busy' };
    await input.alert(
      `Alibaba sync run ${input.runId} quarantine approved; ${promoted} product(s) promoted.`,
    );
    return { ok: true, runId: input.runId, promoted };
  } finally {
    await releaseAlibabaSyncLease(PRIMARY_CONNECTION_ID, holder, grant.fence, input.now());
  }
}
