import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import {
  CATALOG_PRODUCT_OPERATION_INPUT_MAX_BYTES,
  type CatalogProductOperationStatus,
  CatalogProductOperationStatusSchema,
  CatalogReferenceRecoveryCursorSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { z } from 'zod';
import { AdminApiError, catalogProductOperationCall } from './api.ts';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.object({ productId: id, operationId: z.string().uuid() });
const start = scope
  .extend({
    action: z.literal('product-operation-start'),
    intent: z.literal('publish'),
    expectedUpdatedAt: z.string().datetime().nullable(),
    values: z.record(z.unknown()),
  })
  .strict();
const command = z.discriminatedUnion('action', [
  start,
  scope.extend({ action: z.literal('product-operation-get') }).strict(),
  scope
    .extend({
      action: z.literal('product-operation-continue'),
      inputDigest: digest,
      referenceRecovery: CatalogReferenceRecoveryCursorSchema.optional(),
    })
    .strict(),
  scope.extend({ action: z.literal('product-operation-cancel'), inputDigest: digest }).strict(),
]);
export type PublicationCommand = z.infer<typeof command>;
export const PublicationScopeSchema = scope.extend({ inputDigest: digest.optional() }).strict();
export type PublicationScope = Readonly<z.infer<typeof PublicationScopeSchema>>;
export type PublicationAttempt = Readonly<z.infer<typeof start>>;
export type PublicationStep = {
  status: CatalogProductOperationStatus;
  recovery: 'none' | 'status';
};
export interface PublicationOptions {
  signal?: AbortSignal;
  expectedInputDigest?: string;
  request?: (command: PublicationCommand, signal?: AbortSignal) => Promise<unknown>;
}
const definite = new Set([
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'SOURCE_NOT_READY',
  'MEDIA_NOT_READY',
  'MEDIA_BUSY',
  'BUSY',
  'APPROVAL_EXPIRED',
  'APPROVAL_TOO_LARGE',
]);
const invalidRequest = () =>
  new AdminApiError('VALIDATION_ERROR', 'Check the publication request before trying again.');

export function capturePublicationCommand(input: unknown): PublicationCommand {
  const max =
    input && typeof input === 'object' && Reflect.get(input, 'action') === 'product-operation-start'
      ? CATALOG_PRODUCT_OPERATION_INPUT_MAX_BYTES
      : 4096;
  if (!fitsJsonBudget(input, max, 28)) throw invalidRequest();
  let wire: unknown;
  try {
    wire = JSON.parse(JSON.stringify(input));
  } catch {
    throw invalidRequest();
  }
  const parsed = command.safeParse(wire);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Generate once before the first request. Retrying this input keeps this same attempt. */
export function createPublicationAttempt(input: {
  productId: string;
  expectedUpdatedAt: string | null;
  values: Record<string, unknown>;
}): PublicationAttempt {
  const value = capturePublicationCommand({
    ...input,
    action: 'product-operation-start',
    intent: 'publish',
    operationId: crypto.randomUUID(),
  });
  if (value.action !== 'product-operation-start') throw invalidRequest();
  return freezeJson(value);
}

export function readPublicationStatus(
  value: unknown,
  expected: PublicationScope,
): CatalogProductOperationStatus {
  const parsed = CatalogProductOperationStatusSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.productId !== expected.productId ||
    parsed.data.operationId !== expected.operationId ||
    parsed.data.intent !== 'publish' ||
    (expected.inputDigest !== undefined && parsed.data.inputDigest !== expected.inputDigest)
  )
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Publication status could not be confirmed. Check this publication again.',
    );
  return parsed.data;
}

/** An unreadable outcome retains only its original scope, never guesses success or cancellation. */
export class PublicationStatusUnknownError extends AdminApiError {
  readonly scope: PublicationScope;
  constructor(expected: PublicationScope, original: unknown, confirmation?: { error: unknown }) {
    const failure = confirmation?.error;
    const code =
      failure instanceof AdminApiError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(failure.code)
        ? failure.code
        : 'OPERATION_UNCONFIRMED';
    super(
      code,
      code === 'OPERATION_UNCONFIRMED'
        ? 'Publication could not be checked. Check this publication again before retrying.'
        : 'Sign in with the same account to check this publication. Its outcome is still unknown.',
    );
    this.name = 'PublicationStatusUnknownError';
    this.scope = freezeJson({ ...expected });
    this.cause =
      confirmation === undefined
        ? original
        : new AggregateError([original, failure], 'Publication response and confirmation failed');
  }
}

/** One public command, followed only by a scoped read if its write response is unknown. */
export async function managePublication(
  input: unknown,
  options: PublicationOptions = {},
): Promise<PublicationStep> {
  const checked = capturePublicationCommand(input);
  const action = checked.action;
  const expectedDigest = options.expectedInputDigest;
  if (
    (expectedDigest !== undefined && !digest.safeParse(expectedDigest).success) ||
    (checked.action === 'product-operation-start' && expectedDigest !== undefined) ||
    ('inputDigest' in checked &&
      expectedDigest !== undefined &&
      checked.inputDigest !== expectedDigest)
  )
    throw invalidRequest();
  const expected: PublicationScope = {
    productId: checked.productId,
    operationId: checked.operationId,
    ...('inputDigest' in checked
      ? { inputDigest: checked.inputDigest }
      : expectedDigest !== undefined
        ? { inputDigest: expectedDigest }
        : {}),
  };
  const request = options.request ?? catalogProductOperationCall;
  const signal = options.signal;
  signal?.throwIfAborted();
  try {
    return {
      status: readPublicationStatus(await request(checked, signal), expected),
      recovery: 'none',
    };
  } catch (original) {
    if (
      action === 'product-operation-get' ||
      (original instanceof AdminApiError && definite.has(original.code))
    )
      throw original;
    if (signal?.aborted) throw new PublicationStatusUnknownError(expected, original);
    try {
      const current = await request(
        {
          action: 'product-operation-get',
          productId: expected.productId,
          operationId: expected.operationId,
        },
        signal,
      );
      return { status: readPublicationStatus(current, expected), recovery: 'status' };
    } catch (confirmation) {
      throw new PublicationStatusUnknownError(expected, original, { error: confirmation });
    }
  }
}
