/** Source writers and approval must compete on the same bound product record. */
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { normalizedSourceInputDigest, sourceInputDigest } from './catalog-source-inputs.ts';
export { sourceInputDigest } from './catalog-source-inputs.ts';
import { advanceCatalogProduct } from './catalog-product-state.ts';

interface ReadStore {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Read-only product write plan: invalidate changed inputs or fence capture metadata. Read before ANY writes. */
export async function planSourceInvalidation(
  store: ReadStore,
  before: CollectionDoc | null,
  next: CollectionDoc | null,
  now: string,
  kind: 'observation' | 'mirror' = 'observation',
): Promise<CollectionDoc | null> {
  const hash = kind === 'mirror' ? normalizedSourceInputDigest : sourceInputDigest;
  const identity = (row: CollectionDoc | null) => {
    if (kind === 'mirror') return { provider: 'alibaba', key: row?._id };
    const observation = record(row?.observation);
    const source = record(observation?.source);
    return {
      provider: row?.provider ?? source?.provider,
      key: row?.sourceProductKey ?? source?.sourceProductKey,
    };
  };
  const previous = identity(before);
  const current = identity(next);
  if (
    before &&
    next &&
    previous.key &&
    current.key &&
    (previous.key !== current.key || previous.provider !== current.provider)
  )
    throw new Error('Source identity cannot change in place');
  const sameInput = hash(before) === hash(next);
  const captureMayChange =
    kind === 'mirror' &&
    before &&
    next &&
    before.contentHash !== undefined &&
    before.payloadId !== next.payloadId;
  if (sameInput && !captureMayChange) return null;
  const { provider, key } = next ? current : previous;
  // Only explicit primary Alibaba bindings affect a canonical product.
  if (provider !== 'alibaba' || typeof key !== 'string' || !key) return null;
  const link = await store.get('alibabaProductLinks', key);
  if (!link) return null;
  if (link.sourceKey !== key || typeof link.productId !== 'string')
    throw new Error('Invalid primary source link');
  if (link.productId === '') return null;
  const product = await store.get('products', link.productId);
  if (product?.alibabaPrimarySourceKey !== key) return null;
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid source invalidation time');
  if (sameInput) {
    const observed = await store.get(
      'catalogSourceObservations',
      sourceObservationDocumentId('alibaba', key),
    );
    // Even a modern/missing observation may change pairing concurrently. The
    // same-value product write serializes that change without advancing content.
    if (!observed || observed.sourceContentHash !== undefined) return product;
  }
  return advanceCatalogProduct(product, product, now, { forceContent: true });
}
