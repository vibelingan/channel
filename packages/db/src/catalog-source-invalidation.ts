/** Source writers and approval must compete on the same bound product record. */
import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';

interface ReadStore {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, stable(object[key])]),
  );
}

/** Capture timestamps and raw evidence IDs do not change the effective source input. */
export function sourceInputDigest(row: CollectionDoc | null): string {
  const observation = record(row?.observation);
  const source = record(observation?.source);
  const { observedAt: _at, ...identity } = source ?? {};
  const { evidence: _evidence, source: _source, ...content } = observation ?? {};
  return createHash('sha256')
    .update(
      JSON.stringify(
        stable({
          active: row?.active !== false,
          observation: observation ? { ...content, source: identity } : null,
        }),
      ),
    )
    .digest('hex');
}

/** Read-only plan. Call before ANY transaction writes, then commit both records together. */
export async function planSourceInvalidation(
  store: ReadStore,
  before: CollectionDoc | null,
  next: CollectionDoc,
  now: string,
): Promise<CollectionDoc | null> {
  if (sourceInputDigest(before) === sourceInputDigest(next)) return null;
  const observation = record(next.observation);
  const source = record(observation?.source);
  const provider = next.provider ?? source?.provider;
  const key = next.sourceProductKey ?? source?.sourceProductKey;
  // Alibaba is the current app's only explicit primary-source binding. Importer
  // observations without such a binding cannot invalidate an unrelated product.
  if (provider !== 'alibaba' || typeof key !== 'string' || !key) return null;
  const link = await store.get('alibabaProductLinks', key);
  if (!link) return null;
  if (link.sourceKey !== key || typeof link.productId !== 'string' || !link.productId)
    throw new Error('Invalid primary source link');
  const product = await store.get('products', link.productId);
  if (product?.alibabaPrimarySourceKey !== key) return null;
  const generation = product.catalogContentGeneration ?? 0;
  if (
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation === Number.MAX_SAFE_INTEGER
  )
    throw new Error('Invalid catalog content generation');
  const currentTime =
    typeof product.updatedAt === 'string' ? Date.parse(product.updatedAt) : Number.NaN;
  const nextTime = Date.parse(now);
  if (!Number.isFinite(nextTime)) throw new Error('Invalid source invalidation time');
  return {
    ...product,
    catalogContentGeneration: generation + 1,
    catalogPreparationState: 'stale',
    detailSourceReady: false,
    updatedAt:
      Number.isFinite(currentTime) && currentTime >= nextTime
        ? new Date(currentTime + 1).toISOString()
        : now,
  };
}
