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
import { computeCandidateHash } from '@vibelingan-channel/alibaba-catalog-sync';
import {
  ALIBABA_SYNC_LEASE_TTL_MS,
  acquireAlibabaSyncLease,
  list,
  releaseAlibabaSyncLease,
} from '@vibelingan-channel/db';
import type { AlertSender } from './alerts.ts';
import { listAllDocs } from './list-all.ts';
import { PRIMARY_CONNECTION_ID } from './oauth.ts';
import { promoteLinkedProduct } from './promotion.ts';
import { getDoc, updateDoc } from './repo.ts';

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
      reason: 'run-not-found' | 'not-quarantined' | 'superseded' | 'lease-busy';
    };

async function recomputeCandidates(runId: string, mode: string) {
  // Must reproduce the runner's set EXACTLY — both sides now use the same
  // complete cursor walk, or the frozen candidate hash can never match.
  const seen = await listAllDocs('alibabaSourceProducts', [
    { field: 'lastSeenRunId', op: 'eq', value: runId },
  ]);
  const candidates: { sourceKey: string }[] = [];
  for (const source of seen) {
    const link = await getDoc('alibabaProductLinks', source._id);
    if (link && typeof link.productId === 'string' && link.productId !== '') {
      candidates.push({ sourceKey: source._id });
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
  const run = await getDoc('alibabaSyncRuns', input.runId);
  if (!run) return { ok: false, reason: 'run-not-found' };
  if (run.status !== 'quarantined') return { ok: false, reason: 'not-quarantined' };

  const { candidates, tombstones } = await recomputeCandidates(input.runId, String(run.mode ?? ''));
  const recomputedHash = computeCandidateHash({
    runId: input.runId,
    candidates,
    tombstones,
  });
  if (recomputedHash !== run.candidateHash || input.candidateHash !== run.candidateHash) {
    return { ok: false, reason: 'superseded' };
  }

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
    let promoted = 0;
    for (const candidate of candidates) {
      const result = await promoteLinkedProduct({
        sourceKey: candidate.sourceKey,
        guard: {
          connectionId: PRIMARY_CONNECTION_ID,
          holder,
          fence: grant.fence,
          now: input.now(),
        },
        now: input.now(),
      });
      if (result.ok && result.changed) promoted += 1;
    }
    await updateDoc('alibabaSyncRuns', input.runId, {
      status: 'approved',
      approval: {
        approvedByUserId: input.approvedByUserId,
        approvedAt: input.now(),
        candidateHash: run.candidateHash,
        reason: 'operator-approved',
      },
    });
    await input.alert(
      `Alibaba sync run ${input.runId} quarantine approved; ${promoted} product(s) promoted.`,
    );
    return { ok: true, runId: input.runId, promoted };
  } finally {
    await releaseAlibabaSyncLease(PRIMARY_CONNECTION_ID, holder, grant.fence, input.now());
  }
}
