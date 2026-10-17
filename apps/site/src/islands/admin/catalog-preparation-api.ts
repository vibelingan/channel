import {
  CATALOG_PREPARATION_POLICY,
  CatalogPreparationReportSchema,
} from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import { AdminApiError, catalogPreparationCall } from './api.ts';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), productId: id }).strict(),
  z.object({ action: z.literal('status'), jobId: hex }).strict(),
  z.object({ action: z.literal('continue'), jobId: hex }).strict(),
  z.object({ action: z.literal('cancel'), jobId: hex, expectedLeaseVersion: count }).strict(),
  z.object({ action: z.literal('retry'), jobId: hex, expectedLeaseVersion: count }).strict(),
]);
export type PreparationCommand = z.infer<typeof command>;
const media = z
  .object({ total: count, checked: count, verified: count, invalid: count, retry: count })
  .strict()
  .refine(
    (value) =>
      value.checked <= value.total &&
      value.verified + value.invalid + value.retry === value.checked,
  );
const progress = z
  .object({
    jobId: hex,
    productId: id,
    state: z.enum(['queued', 'running', 'retryable', 'cancelled', 'stale', 'blocked', 'completed']),
    attempt: count,
    leaseVersion: count,
    leaseExpiresAt: count,
    createdAt: z.string().max(40).datetime(),
    updatedAt: z.string().max(40).datetime(),
    media: media.nullable(),
  })
  .strict();
const status = z
  .object({
    progress,
    current: z.boolean(),
    report: CatalogPreparationReportSchema.nullable(),
    attestation: z
      .object({ total: count, checked: count })
      .strict()
      .refine((value) => value.checked <= value.total)
      .nullable(),
    nextAction: z.enum(['continue', 'retry', 'edit', 'restart', 'wait', 'ready']),
  })
  .strict()
  .refine((value) => {
    const report = value.report;
    if (
      report &&
      (report.productId !== value.progress.productId ||
        report.policyVersion !== CATALOG_PREPARATION_POLICY)
    )
      return false;
    if (
      !value.current &&
      (report !== null || value.attestation !== null || value.nextAction !== 'restart')
    )
      return false;
    if (value.attestation && value.attestation.total !== value.progress.media?.total) return false;
    if (value.nextAction !== 'ready') return true;
    return (
      value.current &&
      value.progress.state === 'completed' &&
      report?.state === 'ready' &&
      report.seal.jobId === value.progress.jobId &&
      report.seal.imageCount === value.progress.media?.total &&
      value.progress.media.checked === value.progress.media.total &&
      value.progress.media.verified === value.progress.media.total &&
      value.attestation?.checked === value.progress.media.total
    );
  });
export type PreparationStatus = z.infer<typeof status>;
const code = z.enum([
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CORRUPT',
  'CONFLICT',
  'BUSY',
  'STALE',
  'UNAVAILABLE',
]);
const response = z.union([
  z.object({ ok: z.literal(true), progress }).strict(),
  z.object({ ok: z.literal(true), status, recovery: z.literal('status').optional() }).strict(),
  z
    .object({
      ok: z.literal(true),
      status,
      followUp: z.enum(['continue', 'poll', 'none']),
      invocation: z.enum(['skipped', 'acknowledged', 'rejected', 'unconfirmed', 'recovered']),
      failureCode: code.optional(),
      recovery: z.literal('status').optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.followUp !== 'continue' ||
        (value.invocation === 'acknowledged' &&
          value.status.current &&
          value.status.nextAction === 'continue' &&
          value.status.progress.state === 'queued' &&
          value.status.report?.state === 'preparing'),
    ),
]);
export type PreparationResponse = z.infer<typeof response>;
export function readPreparationResponse(
  value: unknown,
  expected: { jobId?: string; productId?: string; action?: PreparationCommand['action'] } = {},
): PreparationResponse {
  const result = response.safeParse(value);
  if (!result.success)
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Preparation response could not be read. Check the current task.',
    );
  if (
    (expected.action === 'status' && !('status' in result.data)) ||
    (expected.action === 'continue' && !('followUp' in result.data)) ||
    (expected.action === 'start' && !('progress' in result.data))
  )
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Preparation response does not match the requested action.',
    );
  const resultProgress =
    'status' in result.data ? result.data.status.progress : result.data.progress;
  if (
    (expected.jobId !== undefined && resultProgress.jobId !== expected.jobId) ||
    (expected.productId !== undefined && resultProgress.productId !== expected.productId)
  )
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Preparation response belongs to a different task.',
    );
  return result.data;
}
export async function managePreparation(input: PreparationCommand, signal?: AbortSignal) {
  const checked = command.safeParse(input);
  if (!checked.success) throw new AdminApiError('VALIDATION_ERROR', 'Invalid preparation request.');
  return readPreparationResponse(
    await catalogPreparationCall(checked.data, signal),
    checked.data.action === 'start'
      ? { productId: checked.data.productId, action: checked.data.action }
      : { jobId: checked.data.jobId, action: checked.data.action },
  );
}

export type PreparationRunResult = {
  productId: string;
  jobId?: string;
  status?: PreparationStatus;
  reason: 'ready' | 'needs-action' | 'paused' | 'unknown';
  errorCode?: string;
};
type Options = {
  signal?: AbortSignal;
  request?: (command: PreparationCommand, signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  onProgress?: (status: { progress: z.infer<typeof progress>; status?: PreparationStatus }) => void;
};
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** A stopped browser wait leaves the remote task available for status and explicit continuation. */
export async function runPreparation(
  input: { productId: string; jobId?: string },
  options: Options = {},
): Promise<PreparationRunResult> {
  const productId = id.parse(input.productId);
  if (input.jobId !== undefined) hex.parse(input.jobId);
  const request = options.request ?? managePreparation;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), 120000);
  const signal = options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
  let jobId = input.jobId;
  let current: PreparationStatus | undefined;
  let calls = 0;
  let polls = 0;
  const result = (
    reason: PreparationRunResult['reason'],
    errorCode?: string,
  ): PreparationRunResult => ({
    productId,
    ...(jobId ? { jobId } : {}),
    ...(current ? { status: current } : {}),
    reason,
    ...(errorCode ? { errorCode } : {}),
  });
  const canRequest = () => {
    const time = now();
    return (
      !signal.aborted &&
      calls < 64 &&
      Number.isFinite(time) &&
      time >= started &&
      time - started < 120000
    );
  };
  const send = async (action: PreparationCommand): Promise<PreparationResponse> => {
    calls++;
    const value = readPreparationResponse(await request(action, signal), {
      action: action.action,
      productId,
      ...(jobId ? { jobId } : {}),
    });
    const observed = 'status' in value ? value.status.progress : value.progress;
    jobId = observed.jobId;
    if ('status' in value) current = value.status;
    options.onProgress?.({ progress: observed, ...(current ? { status: current } : {}) });
    return value;
  };
  try {
    if (!canRequest()) return result('paused');
    let observed: PreparationResponse;
    try {
      observed = await send(jobId ? { action: 'status', jobId } : { action: 'start', productId });
    } catch (error) {
      return result(
        signal.aborted
          ? 'paused'
          : error instanceof AdminApiError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)
            ? 'needs-action'
            : 'unknown',
        error instanceof AdminApiError ? error.code : undefined,
      );
    }
    let mode: 'continue' | 'poll' | 'none' =
      'status' in observed
        ? observed.status.nextAction === 'continue' && observed.status.current
          ? 'continue'
          : observed.status.nextAction === 'wait'
            ? 'poll'
            : 'none'
        : 'continue';
    while (true) {
      if (current?.nextAction === 'ready') return result('ready');
      if (mode === 'none') return result('needs-action');
      if (!canRequest() || !jobId) return result('paused');
      if (mode === 'poll') {
        if (polls >= 4) return result('paused');
        try {
          const delay = polls === 0 ? 600 : polls === 1 ? 1200 : 2400;
          polls++;
          await (options.wait ?? pause)(delay, signal);
        } catch {
          return result('paused');
        }
        if (!canRequest()) return result('paused');
      }
      const wasPoll = mode === 'poll';
      try {
        observed = await send({ action: wasPoll ? 'status' : 'continue', jobId });
      } catch (error) {
        if (signal.aborted) return result('paused');
        if (error instanceof AdminApiError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code))
          return result('needs-action', error.code);
        if (wasPoll || !canRequest()) return result('unknown');
        let recovered: PreparationResponse;
        try {
          recovered = await send({ action: 'status', jobId });
        } catch (recoveryError) {
          return result(
            signal.aborted
              ? 'paused'
              : recoveryError instanceof AdminApiError &&
                  ['UNAUTHORIZED', 'FORBIDDEN'].includes(recoveryError.code)
                ? 'needs-action'
                : 'unknown',
            recoveryError instanceof AdminApiError ? recoveryError.code : undefined,
          );
        }
        return result(
          'status' in recovered && recovered.status.nextAction === 'ready'
            ? 'ready'
            : 'needs-action',
        );
      }
      mode = wasPoll
        ? current?.nextAction === 'wait'
          ? 'poll'
          : 'none'
        : 'followUp' in observed
          ? observed.followUp
          : 'none';
    }
  } finally {
    clearTimeout(timer);
  }
}
