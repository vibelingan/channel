import type { CollectionDoc } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { z } from 'zod';
import { getToken } from '../../lib/session.ts';
import { AdminApiError, catalogProductCreateCall } from './api.ts';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.object({ attemptId: z.string().uuid(), inputDigest: digestSchema }).strict();
export type ProductCreationScope = Readonly<z.infer<typeof scopeSchema>>;
export type ProductCreationAttempt = ProductCreationScope & {
  readonly values: Readonly<Record<string, unknown>>;
};
const resultSchema = z
  .object({
    schemaVersion: z.literal('catalog-product-create-result-v1'),
    attemptId: z.string().uuid(),
    inputDigest: digestSchema,
    productId: z.string().regex(/^[a-f0-9]{64}$/),
    product: z
      .object({
        _id: z.string().regex(/^[a-f0-9]{64}$/),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
      .passthrough(),
  })
  .strict();
export type ProductCreationResult = z.infer<typeof resultSchema>;
type CreationCommand =
  | { action: 'start'; attemptId: string; values: Readonly<Record<string, unknown>> }
  | ({ action: 'get' } & ProductCreationScope);
export type ProductCreationRequest = (
  input: CreationCommand,
  guard: () => void,
) => Promise<unknown>;

export async function captureProductCreation(
  values: Record<string, unknown>,
): Promise<ProductCreationAttempt> {
  if (!fitsJsonBudget(values, 240 * 1024, 24))
    throw new AdminApiError('VALIDATION_ERROR', 'The product draft is too large.');
  const bytes = JSON.stringify(values);
  const snapshot: Record<string, unknown> = JSON.parse(bytes);
  const inputDigest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const freeze = (value: unknown) => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(snapshot);
  return Object.freeze({ attemptId: crypto.randomUUID(), inputDigest, values: snapshot });
}

export class ProductCreationUnknownError extends AdminApiError {
  constructor(
    readonly scope: ProductCreationScope,
    cause: unknown,
  ) {
    super(
      'CREATION_UNCONFIRMED',
      'Creation could not be confirmed. Check this original attempt before creating another product.',
    );
    this.cause = cause;
  }
}

export class CreatedProductChangedError extends AdminApiError {
  constructor(readonly product: CollectionDoc) {
    super(
      'CREATION_CHANGED',
      'The original product was recovered. Open the saved product to review its current state before publishing.',
    );
  }
}

function readResult(value: unknown, scope: ProductCreationScope): ProductCreationResult {
  const result = resultSchema.safeParse(value);
  if (
    !result.success ||
    result.data.attemptId !== scope.attemptId ||
    result.data.inputDigest !== scope.inputDigest ||
    result.data.productId !== result.data.product._id
  )
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'The original creation receipt could not be confirmed.',
    );
  return result.data;
}

export async function checkProductCreation(
  scope: ProductCreationScope,
  request: ProductCreationRequest = catalogProductCreateCall,
  guard: () => void = () => {},
): Promise<ProductCreationResult> {
  const selected = scopeSchema.parse(scope);
  guard();
  const value = await request({ action: 'get', ...selected }, guard);
  guard();
  return readResult(value, selected);
}

const definite = new Set([
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'CONFLICT',
  'IDENTITY_CONFLICT',
  'INVALID_IDENTITY',
  'INVALID_PRODUCT',
  'BUSY',
  'MEDIA_BUSY',
]);

/** An uncertain start is followed by one original read, never by another create. */
export async function startProductCreation(
  attempt: ProductCreationAttempt,
  request: ProductCreationRequest = catalogProductCreateCall,
  guard?: () => void,
): Promise<ProductCreationResult> {
  const token = getToken();
  const assertCurrent =
    guard ??
    (() => {
      if (getToken() !== token)
        throw new AdminApiError(
          'UNAUTHORIZED',
          'Sign in with the original account to check this creation.',
        );
    });
  assertCurrent();
  try {
    const value = await request(
      { action: 'start', attemptId: attempt.attemptId, values: attempt.values },
      assertCurrent,
    );
    assertCurrent();
    return readResult(value, attempt);
  } catch (error) {
    if (error instanceof AdminApiError && definite.has(error.code)) throw error;
    try {
      return await checkProductCreation(
        { attemptId: attempt.attemptId, inputDigest: attempt.inputDigest },
        request,
        assertCurrent,
      );
    } catch (confirmation) {
      if (
        confirmation instanceof AdminApiError &&
        ['UNAUTHORIZED', 'FORBIDDEN'].includes(confirmation.code)
      )
        throw confirmation;
      throw new ProductCreationUnknownError(
        { attemptId: attempt.attemptId, inputDigest: attempt.inputDigest },
        new AggregateError([error, confirmation], 'Creation response and confirmation failed'),
      );
    }
  }
}
