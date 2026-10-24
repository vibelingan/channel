/** Deletion holds for resumable preparation; a hold is never pixel or readiness evidence. */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CATALOG_PREPARATION_POLICY,
  readCurrentCatalogPreparation,
} from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import type { DbAdapter } from './adapter.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import { CATALOG_IMAGE_OBSERVATIONS } from './catalog-image-observation.ts';
import type { CatalogPreparationJobRecord } from './catalog-preparation-jobs.ts';
import {
  catalogPreparationInputDigest,
  readCatalogPreparationInputs,
} from './catalog-preparation-store.ts';
const kind = 'catalog-preparation-image-hold-v1';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v.trim() === v);
const schema = z
  .object({
    _id: hex,
    kind: z.literal(kind),
    policyVersion: z.literal(CATALOG_PREPARATION_POLICY),
    jobId: hex,
    nonce: hex,
    productId: id,
    inputDigest: hex,
    contentGeneration: z.number().int().nonnegative().safe(),
    imageId: id,
  })
  .strict();
function holdId(job: Pick<CatalogPreparationJobRecord, '_id' | 'nonce'>, imageId: string) {
  return alibabaPricingFingerprint([kind, CATALOG_PREPARATION_POLICY, job._id, job.nonce, imageId]);
}
export function catalogPreparationImageHold(
  job: CatalogPreparationJobRecord,
  imageId: string,
): CollectionDoc {
  return schema.parse({
    _id: holdId(job, imageId),
    kind,
    policyVersion: CATALOG_PREPARATION_POLICY,
    jobId: job._id,
    nonce: job.nonce,
    productId: job.productId,
    inputDigest: job.inputDigest,
    contentGeneration: job.contentGeneration,
    imageId,
  });
}
export function matchesCatalogPreparationImageHold(
  raw: unknown,
  job: CatalogPreparationJobRecord,
  imageId: string,
): boolean {
  const p = schema.safeParse(raw);
  if (!p.success) return false;
  const r = p.data;
  return (
    r._id === holdId(job, imageId) &&
    r.jobId === job._id &&
    r.nonce === job.nonce &&
    r.productId === job.productId &&
    r.inputDigest === job.inputDigest &&
    r.contentGeneration === job.contentGeneration &&
    r.imageId === imageId
  );
}
/** Caller holds the image mutex throughout this scan and any subsequent deletion. */
export async function findCatalogPreparationImageHold(
  store: Pick<DbAdapter, 'get' | 'list'>,
  imageId: string,
  now: number,
  readJob: (raw: unknown, jobId: string, now: number) => CatalogPreparationJobRecord | null,
): Promise<string | null> {
  let cursor = '';
  const jobs = new Map<string, Promise<CatalogPreparationJobRecord | null>>();
  for (;;) {
    const page = await store.list({
      collection: CATALOG_IMAGE_OBSERVATIONS,
      page: 1,
      pageSize: 100,
      search: '',
      sort: [{ field: '_id', dir: 'asc' }],
      filter: {
        combinator: 'and',
        clauses: [
          { field: 'kind', op: 'eq', value: kind },
          { field: 'imageId', op: 'eq', value: imageId },
          ...(cursor ? [{ field: '_id', op: 'gt' as const, value: cursor }] : []),
        ],
      },
    });
    for (const raw of page.items) {
      if (raw.kind !== kind || raw.imageId !== imageId) continue;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw Error('Corrupt preparation image hold');
      const hold = parsed.data;
      if (hold._id !== holdId({ _id: hold.jobId, nonce: hold.nonce }, imageId))
        throw Error('Preparation image hold identity changed');
      let pending = jobs.get(hold.jobId);
      if (!pending) {
        pending = store.get('catalogPreparationJobs', hold.jobId).then((rawJob) => {
          if (!rawJob) return null;
          const job = readJob(rawJob, hold.jobId, now);
          if (!job) throw Error('Corrupt held preparation job');
          return job;
        });
        jobs.set(hold.jobId, pending);
      }
      const job = await pending;
      if (
        !job ||
        !matchesCatalogPreparationImageHold(hold, job, imageId) ||
        !['queued', 'running', 'retryable', 'blocked', 'completed'].includes(job.state)
      )
        continue;
      const product = await store.get('products', job.productId);
      if (!product) continue;
      if (product._id !== job.productId) throw Error('Held preparation product identity changed');
      if (
        (product.catalogContentGeneration ?? 0) !== job.contentGeneration ||
        catalogPreparationInputDigest(await readCatalogPreparationInputs(store, product)) !==
          job.inputDigest
      )
        continue;
      if (job.state === 'completed') {
        const report = readCurrentCatalogPreparation(product);
        if (report?.state !== 'ready' || report.inputDigest !== job.inputDigest) continue;
      }
      return job.productId;
    }
    if (page.items.length < 100) return null;
    const last = page.items.at(-1)?._id;
    if (typeof last !== 'string' || !last || last <= cursor)
      throw Error('Preparation hold cursor did not advance');
    cursor = last;
  }
}
