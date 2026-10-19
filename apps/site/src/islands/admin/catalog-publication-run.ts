import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import type { CatalogIssue } from '@vibelingan-channel/shared/catalog-issues';
import {
  type CatalogProductOperationStatus,
  type CatalogReferenceRecoveryCursor,
  CatalogReferenceRecoveryCursorSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { AdminApiError, catalogProductOperationCall } from './api.ts';
import {
  type PreparationCommand,
  type PreparationRunResult,
  managePreparation,
  runPreparation,
} from './catalog-preparation-api.ts';
import {
  type PublicationAttempt,
  type PublicationCommand,
  type PublicationOptions,
  type PublicationScope,
  PublicationScopeSchema,
  PublicationStatusUnknownError,
  capturePublicationCommand,
  managePublication,
} from './catalog-product-operation-api.ts';

const RUN_MS = 120000;
const MAX_REQUESTS = 64;
const MAX_IDLE = 4;
type Failure = { code: string; message: string; issues: readonly CatalogIssue[] };
export type PublicationRunResult = {
  reason: 'committed' | 'historical' | 'cancelled' | 'needs-action' | 'paused' | 'unknown';
  scope: PublicationScope;
  status?: CatalogProductOperationStatus;
  error?: Failure;
  preparation?: PreparationRunResult;
  observerFailed?: boolean;
  observerError?: unknown;
  referenceRecovery?: CatalogReferenceRecoveryCursor;
  requests: number;
};
export type PublicationRunOptions = {
  signal?: AbortSignal;
  request?: PublicationOptions['request'];
  preparationRequest?: (command: PreparationCommand, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  onStatus?: (status: CatalogProductOperationStatus) => void | Promise<void>;
  referenceRecovery?: CatalogReferenceRecoveryCursor;
};
class RunPaused extends Error {}
class ScopeStopped extends Error {}
const describe = (error: unknown): Failure =>
  error instanceof AdminApiError
    ? { code: error.code, message: error.message, issues: error.issues }
    : {
        code: 'UNAVAILABLE',
        message: 'Publication could not be checked. Check its current status.',
        issues: [],
      };
function delay(ms: number, signal: AbortSignal) {
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
function target(input: unknown): { scope: PublicationScope; start?: PublicationAttempt } {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new AdminApiError('VALIDATION_ERROR', 'Invalid publication scope.');
  if ('action' in input) {
    const checked = capturePublicationCommand(input);
    if (checked.action !== 'product-operation-start')
      throw new AdminApiError('VALIDATION_ERROR', 'Select the saved publication to continue.');
    return {
      scope: Object.freeze({ productId: checked.productId, operationId: checked.operationId }),
      start: checked,
    };
  }
  if (!fitsJsonBudget(input, 4096, 12))
    throw new AdminApiError('VALIDATION_ERROR', 'Invalid publication scope.');
  const parsed = PublicationScopeSchema.safeParse(input);
  if (!parsed.success) throw new AdminApiError('VALIDATION_ERROR', 'Invalid publication scope.');
  return { scope: Object.freeze(parsed.data) };
}
function referencePage(status: CatalogProductOperationStatus) {
  if (
    status.state !== 'staging' ||
    !status.current ||
    !status.revisionCurrent ||
    status.expired ||
    status.cancelledAt ||
    !status.approval.mediaReady ||
    status.approval.configurations.completed !== status.approval.configurations.total ||
    !status.approval.references.prepared ||
    status.approval.references.staged >= status.approval.references.total
  )
    return undefined;
  return JSON.stringify([status.approval.revision, status.approval.references]);
}
function fingerprint(status: CatalogProductOperationStatus) {
  return JSON.stringify([
    status.state,
    'approval' in status ? status.approval : null,
    status.preparation,
    status.referenceRecovery,
  ]);
}

/** Advance only this original publication. A committed result still needs public delivery readback. */
export async function runPublication(
  input: unknown,
  options: PublicationRunOptions = {},
): Promise<PublicationRunResult> {
  const captured = target(input);
  const checkpoint = CatalogReferenceRecoveryCursorSchema.optional().safeParse(
    options.referenceRecovery,
  );
  if (!checkpoint.success || (checkpoint.data && !captured.scope.inputDigest))
    throw new AdminApiError('VALIDATION_ERROR', 'Invalid publication checkpoint.');
  let referenceRecovery = checkpoint.data;
  let binding: PublicationScope = captured.scope;
  const request = options.request ?? catalogProductOperationCall;
  const preparationRequest = options.preparationRequest ?? managePreparation;
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? delay;
  const onStatus = options.onStatus;
  const started = now();
  if (!Number.isFinite(started) || started < 0)
    throw new AdminApiError('VALIDATION_ERROR', 'Reload the page before continuing publication.');
  const budget = new AbortController();
  let signal = budget.signal;
  const timer = setTimeout(
    () => budget.abort(new RunPaused('Publication time limit reached')),
    RUN_MS,
  );
  let requests = 0;
  let current: CatalogProductOperationStatus | undefined;
  let preparation: PreparationRunResult | undefined;
  let observerFailed = false;
  let observerError: unknown;
  let paused = false;
  let idle = 0;
  let prior = '';
  const result = (
    reason: PublicationRunResult['reason'],
    error?: Failure,
  ): PublicationRunResult => ({
    reason,
    scope: binding,
    ...(current ? { status: current } : {}),
    ...(preparation ? { preparation } : {}),
    ...(error ? { error } : {}),
    ...(observerFailed ? { observerFailed: true, observerError } : {}),
    ...(referenceRecovery ? { referenceRecovery: structuredClone(referenceRecovery) } : {}),
    requests,
  });
  const canRequest = () => {
    const time = now();
    return (
      !signal.aborted &&
      !observerFailed &&
      requests < MAX_REQUESTS &&
      Number.isFinite(time) &&
      time >= started &&
      time - started < RUN_MS
    );
  };
  const admit = () => {
    if (!canRequest()) {
      paused = true;
      throw new RunPaused('Publication paused before another request');
    }
    requests++;
  };
  const observe = async (status: CatalogProductOperationStatus, readOnly: boolean) => {
    const previous = current;
    current = status;
    const page = referencePage(status);
    referenceRecovery =
      status.referenceRecovery?.cursor ??
      (readOnly && page && (!previous || page === referencePage(previous))
        ? referenceRecovery
        : undefined);
    binding = Object.freeze({
      productId: status.productId,
      operationId: status.operationId,
      inputDigest: status.inputDigest,
    });
    if (!onStatus) return;
    try {
      // Await persistence before another write; always consume a late rejection after abort.
      const notification = Promise.resolve().then(() => onStatus(structuredClone(status)));
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        notification.then(
          () => {
            signal.removeEventListener('abort', abort);
            resolve();
          },
          (error) => {
            signal.removeEventListener('abort', abort);
            reject(error);
          },
        );
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    } catch (error) {
      observerFailed = true;
      observerError = error;
    }
  };
  const terminal = (): PublicationRunResult | undefined => {
    if (!current) return undefined;
    if (current.state === 'complete') return result(current.current ? 'committed' : 'historical');
    if (current.cancelledAt) return result('cancelled');
    if (current.expired)
      return result('needs-action', {
        code: 'APPROVAL_EXPIRED',
        message: 'This publication expired. Review the product before starting again.',
        issues: [],
      });
    if (!current.current || !current.revisionCurrent)
      return result('needs-action', {
        code: 'CONFLICT',
        message: 'The product changed. Review its current version before publishing.',
        issues: [],
      });
    return undefined;
  };
  const dispatch = async (command: PublicationCommand, operationSignal?: AbortSignal) => {
    admit();
    // An issued continuation may change the ledger even if its reply is lost.
    if (command.action === 'product-operation-continue') referenceRecovery = undefined;
    return request(command, operationSignal);
  };
  const perform = async (command: PublicationCommand) => {
    const before = requests;
    try {
      const answer = await managePublication(command, {
        request: dispatch,
        signal,
        ...(command.action === 'product-operation-get' && binding.inputDigest
          ? { expectedInputDigest: binding.inputDigest }
          : {}),
      });
      await observe(answer.status, command.action === 'product-operation-get');
      return answer;
    } catch (error) {
      if (paused && requests === before) throw new RunPaused('Publication paused before dispatch');
      throw error;
    }
  };
  const query = () =>
    perform({
      action: 'product-operation-get',
      productId: binding.productId,
      operationId: binding.operationId,
    });
  try {
    if (options.signal) signal = AbortSignal.any([options.signal, budget.signal]);
    if (!canRequest()) return result('paused');
    try {
      await (captured.start ? perform(captured.start) : query());
    } catch (error) {
      if (error instanceof RunPaused) return result('paused');
      return result(
        error instanceof PublicationStatusUnknownError || !captured.start
          ? 'unknown'
          : 'needs-action',
        describe(error),
      );
    }
    while (true) {
      const done = terminal();
      if (done) return done;
      if (!canRequest()) return result('paused');
      const active = current;
      if (!active) return result('unknown');
      const hint = active.preparation;
      if (hint) {
        if (['retry', 'edit', 'repair'].includes(hint.nextAction))
          return result('needs-action', {
            code: 'MEDIA_NOT_READY',
            message: 'Check the product photos before continuing this publication.',
            issues: [],
          });
        preparation = await runPreparation(
          { productId: binding.productId, ...(hint.job ? { jobId: hint.job.id } : {}) },
          {
            signal,
            now,
            wait,
            request: async (command, preparationSignal) => {
              if (
                command.action === 'start' ||
                command.action === 'continue' ||
                command.action === 'retry'
              ) {
                await query();
                if (terminal())
                  throw new ScopeStopped('The original publication is no longer pending');
              }
              admit();
              return preparationRequest(command, preparationSignal);
            },
          },
        );
        const stopped = terminal();
        if (stopped) return stopped;
        if (observerFailed || paused) return result('paused');
        if (preparation.reason !== 'ready')
          return result(
            preparation.reason === 'needs-action' &&
              ['UNAUTHORIZED', 'FORBIDDEN'].includes(preparation.errorCode ?? '')
              ? 'unknown'
              : preparation.reason === 'needs-action'
                ? 'needs-action'
                : preparation.reason === 'paused'
                  ? 'paused'
                  : 'unknown',
            preparation.errorCode
              ? {
                  code: preparation.errorCode,
                  message: 'Check photo preparation before continuing the same publication.',
                  issues: [],
                }
              : undefined,
          );
        if (!canRequest()) return result('paused');
        try {
          await query();
        } catch (error) {
          return result(error instanceof RunPaused ? 'paused' : 'unknown', describe(error));
        }
        const afterPreparation = terminal();
        if (afterPreparation) return afterPreparation;
        idle = 0;
        prior = '';
      }
      const ready = terminal();
      if (ready) return ready;
      if (!canRequest() || !binding.inputDigest) return result('paused');
      const before = fingerprint(current ?? active);
      const cursor = referenceRecovery;
      try {
        await perform({
          action: 'product-operation-continue',
          productId: binding.productId,
          operationId: binding.operationId,
          inputDigest: binding.inputDigest,
          ...(cursor ? { referenceRecovery: cursor } : {}),
        });
      } catch (error) {
        if (error instanceof RunPaused) return result('paused');
        if (error instanceof PublicationStatusUnknownError)
          return result('unknown', describe(error));
        const failure = describe(error);
        if (['UNAUTHORIZED', 'FORBIDDEN'].includes(failure.code)) return result('unknown', failure);
        try {
          await query();
        } catch (confirmation) {
          return result(confirmation instanceof RunPaused ? 'paused' : 'unknown', failure);
        }
        const confirmed = terminal();
        if (confirmed) return confirmed;
        if (!['BUSY', 'MEDIA_BUSY'].includes(failure.code)) return result('needs-action', failure);
        if (!canRequest()) return result('paused', failure);
        try {
          await wait(400, signal);
        } catch {
          return result('paused', failure);
        }
        continue;
      }
      const completed = terminal();
      if (completed) return completed;
      if (!current) return result('unknown');
      const next = fingerprint(current);
      idle = next === before && next === prior ? idle + 1 : 0;
      prior = next;
      if (idle >= MAX_IDLE) return result('paused');
      if (idle) {
        if (!canRequest()) return result('paused');
        try {
          await wait(Math.min(1200, 200 * 2 ** (idle - 1)), signal);
        } catch {
          return result('paused');
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
