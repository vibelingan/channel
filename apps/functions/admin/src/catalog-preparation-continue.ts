import { isDeepStrictEqual } from 'node:util';
import { manageCatalogPreparationJob } from '@vibelingan-channel/db';
import type {
  CatalogPreparationAuthority,
  CatalogPreparationJobResult,
  CatalogPreparationJobStatus,
} from '@vibelingan-channel/db/catalog-preparation-jobs';
import { CatalogIssueSchema } from '@vibelingan-channel/shared/catalog-issues';
import { z } from 'zod';
import {
  CATALOG_PREPARATION_INVOKE_TIMEOUT_MS,
  type CatalogPreparationInvoker,
} from './catalog-preparation-invoker.ts';

type Failure = Extract<CatalogPreparationJobResult, { ok: false }>;
type Status = { ok: true; status: CatalogPreparationJobStatus };
const count = z.number().int().nonnegative().safe();
const failureCode = z.enum([
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CORRUPT',
  'CONFLICT',
  'BUSY',
  'STALE',
  'UNAVAILABLE',
]);
const step = z
  .object({
    ok: z.literal(true),
    kind: z.literal('catalog-preparation-step'),
    jobId: z.string().regex(/^[a-f0-9]{64}$/),
    productId: z.string().min(1).max(200),
    outcome: z.enum(['partial', 'blocked', 'retryable', 'ready']),
    media: z
      .object({ total: count, checked: count, verified: count, invalid: count, retry: count })
      .strict(),
    attestation: z.object({ total: count, checked: count }).strict().optional(),
    issues: z.array(CatalogIssueSchema).max(50),
  })
  .strict()
  .refine(
    (value) =>
      value.media.checked <= value.media.total &&
      value.media.verified + value.media.invalid + value.media.retry === value.media.checked &&
      (!value.attestation ||
        (value.attestation.total === value.media.total &&
          value.attestation.checked <= value.attestation.total)) &&
      (value.outcome === 'blocked'
        ? value.issues.some((issue) => issue.severity === 'error')
        : value.issues.every((issue) => issue.severity === 'warning')) &&
      (value.outcome !== 'ready' ||
        (value.media.verified === value.media.total &&
          value.media.checked === value.media.total &&
          value.media.invalid === 0 &&
          value.media.retry === 0 &&
          value.attestation?.checked === value.media.total)),
  );
const envelope = z.object({
  result: z.union([step, z.object({ ok: z.literal(false), code: failureCode }).strict()]),
  code: z.literal(0).optional(),
  requestId: z.string().min(1).max(200).optional(),
});
export type CatalogPreparationContinuationResult =
  | Failure
  | {
      ok: true;
      status: CatalogPreparationJobStatus;
      followUp: 'continue' | 'poll' | 'none';
      invocation: 'skipped' | 'acknowledged' | 'rejected' | 'unconfirmed' | 'recovered';
      failureCode?: z.infer<typeof failureCode>;
      recovery?: 'status';
    };
/** Admission and readback only. The worker acknowledgement never grants readiness. */
export async function continueHumanCatalogPreparation(
  authority: CatalogPreparationAuthority,
  actorId: string,
  jobId: string,
  invoke: CatalogPreparationInvoker,
  options: { now?: () => number } = {},
): Promise<CatalogPreparationContinuationResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const read = async (): Promise<Status | Failure> => {
    const command = { action: 'status' as const, actorId, jobId };
    let result: CatalogPreparationJobResult;
    try {
      result = await manageCatalogPreparationJob(authority, command);
    } catch {
      result = await manageCatalogPreparationJob(authority, command);
    }
    if (!result.ok) return { ok: false, code: result.code };
    return 'status' in result && result.status.progress.jobId === jobId
      ? { ok: true, status: result.status }
      : { ok: false, code: 'CORRUPT' };
  };
  const initial = await read();
  if (!initial.ok) return initial;
  if (!initial.status.current || initial.status.nextAction !== 'continue')
    return {
      ...initial,
      followUp: initial.status.nextAction === 'wait' ? 'poll' : 'none',
      invocation: 'skipped',
    };
  function hasHeadroom() {
    const time = now();
    return (
      Number.isSafeInteger(started) &&
      started >= 0 &&
      Number.isSafeInteger(time) &&
      time >= started &&
      time - started + CATALOG_PREPARATION_INVOKE_TIMEOUT_MS < 18000 - 5000
    );
  }
  const waiting = (): CatalogPreparationContinuationResult => ({
    ...initial,
    followUp: 'poll',
    invocation: 'skipped',
    recovery: 'status',
  });
  if (!hasHeadroom()) return waiting();
  let admitted: CatalogPreparationJobResult;
  try {
    admitted = await manageCatalogPreparationJob(authority, { action: 'dispatch', actorId, jobId });
  } catch {
    const current = await read();
    return current.ok
      ? {
          ...current,
          followUp:
            current.status.nextAction === 'wait' || current.status.nextAction === 'continue'
              ? 'poll'
              : 'none',
          invocation: 'unconfirmed',
          recovery: 'status',
        }
      : current;
  }
  if (!admitted.ok) {
    if (admitted.code !== 'CONFLICT' && admitted.code !== 'STALE' && admitted.code !== 'BUSY')
      return { ok: false, code: admitted.code };
    const current = await read();
    return current.ok
      ? {
          ...current,
          followUp:
            current.status.nextAction === 'wait' || current.status.nextAction === 'continue'
              ? 'poll'
              : 'none',
          invocation: 'skipped',
          recovery: 'status',
        }
      : current;
  }
  if (
    !('call' in admitted) ||
    admitted.call.jobId !== jobId ||
    !authority.verifyCall(admitted.call)
  )
    return { ok: false, code: 'CORRUPT' };
  if (!hasHeadroom()) return waiting();
  let acknowledgement: z.infer<typeof step> | null = null;
  let rejected: z.infer<typeof failureCode> | null = null;
  let transportFailed = false;
  let providerCode: string | number | undefined;
  const codeOf = (value: unknown) => {
    const code = value && typeof value === 'object' ? Reflect.get(value, 'code') : undefined;
    return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(code)
      ? code
      : typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599
        ? code
        : undefined;
  };
  try {
    const raw = await invoke(admitted.call);
    providerCode = codeOf(raw);
    const response = envelope.safeParse(raw);
    if (response.success) {
      const result = response.data.result;
      if (!result.ok) rejected = result.code;
      else if (result.jobId === jobId && result.productId === initial.status.progress.productId)
        acknowledgement = result;
    }
  } catch (error) {
    transportFailed = true;
    providerCode = codeOf(error);
  }
  if (!acknowledgement && !rejected)
    console.warn('[catalog-preparation] invocation unconfirmed; reading current state', {
      jobId,
      reason: transportFailed ? 'transport' : 'response',
      ...(providerCode === undefined ? {} : { code: providerCode }),
    });
  const current = await read();
  if (!current.ok) return current;
  if (current.status.nextAction === 'ready')
    return {
      ...current,
      followUp: 'none',
      invocation: acknowledgement?.outcome === 'ready' ? 'acknowledged' : 'recovered',
      ...(acknowledgement?.outcome === 'ready' ? {} : { recovery: 'status' as const }),
    };
  let followUp: 'continue' | 'poll' | 'none' =
    current.status.nextAction === 'wait' ? 'poll' : 'none';
  let invocation: 'acknowledged' | 'rejected' | 'unconfirmed' = acknowledgement
    ? 'acknowledged'
    : rejected
      ? 'rejected'
      : 'unconfirmed';
  if (current.status.nextAction === 'continue') {
    const media = current.status.progress.media;
    const sameMedia =
      acknowledgement &&
      (media
        ? isDeepStrictEqual(media, acknowledgement.media)
        : acknowledgement.media.checked === 0);
    const attestation = current.status.attestation;
    const sameAttestation =
      acknowledgement &&
      (attestation
        ? acknowledgement.attestation?.total === attestation.total &&
          acknowledgement.attestation.checked === attestation.checked
        : !acknowledgement.attestation);
    if (
      acknowledgement?.outcome === 'partial' &&
      current.status.progress.state === 'queued' &&
      current.status.report?.state === 'preparing' &&
      sameMedia &&
      sameAttestation
    )
      followUp = 'continue';
    else if (
      !rejected &&
      (!acknowledgement ||
        acknowledgement.outcome === 'ready' ||
        acknowledgement.outcome === 'partial')
    ) {
      followUp = 'poll';
      invocation = 'unconfirmed';
    }
  }
  return {
    ...current,
    followUp,
    invocation,
    ...(rejected ? { failureCode: rejected } : {}),
    ...(invocation === 'unconfirmed' ? { recovery: 'status' as const } : {}),
  };
}
