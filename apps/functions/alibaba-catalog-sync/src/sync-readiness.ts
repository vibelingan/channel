import { get, manageCatalogPreparationJob } from '@vibelingan-channel/db';
import type { CatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-jobs';
import { z } from 'zod';
import { runCatalogPreparationCall } from './catalog-preparation.ts';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const inputSchema = z
  .object({
    actorId: id,
    runId: id,
    sourceKey: id,
    retries: z.number().int().min(0).max(3),
  })
  .strict();
export type SyncReadinessInput = z.infer<typeof inputSchema>;
export type SyncReadinessResult = {
  outcome: 'complete' | 'continue' | 'waiting' | 'issue' | 'rejected';
  checked: boolean;
  retries: number;
};

/** One original source and one bounded worker step; the timer owns cursor persistence. */
export async function prepareSyncedCatalogSource(
  authority: CatalogPreparationAuthority,
  input: SyncReadinessInput,
  options: { execute?: typeof runCatalogPreparationCall } = {},
): Promise<SyncReadinessResult> {
  const command = inputSchema.parse(input);
  const result = (
    outcome: SyncReadinessResult['outcome'],
    checked = false,
  ): SyncReadinessResult => ({
    outcome,
    checked,
    retries: command.retries,
  });
  const actor = await get('users', command.actorId);
  if (actor?._id !== command.actorId || actor.role !== 'admin' || actor.status === 'suspended')
    return result('rejected');
  const run = await get('alibabaSyncRuns', command.runId);
  if (!run || !['completed', 'approved'].includes(String(run.status))) return result('rejected');
  const source = await get('alibabaSourceProducts', command.sourceKey);
  if (!source || source.active !== true || source.lastSeenRunId !== command.runId)
    return result('complete');
  const link = await get('alibabaProductLinks', command.sourceKey);
  if (!link || link.sourceKey !== command.sourceKey || typeof link.productId !== 'string')
    return result('issue');
  const product = await get('products', link.productId);
  if (!product || product.alibabaPrimarySourceKey !== command.sourceKey) return result('issue');
  if (product.published === true || product.archived === true) return result('complete');
  const started = await manageCatalogPreparationJob(authority, {
    action: 'start',
    actorId: command.actorId,
    productId: product._id,
  });
  if (!started.ok) {
    if (started.code === 'FORBIDDEN') return result('rejected');
    if (['BUSY', 'CONFLICT', 'STALE'].includes(started.code)) return result('waiting');
    return result('issue');
  }
  if (!('progress' in started)) return result('issue');
  const jobId = started.progress.jobId;
  const status = async () => {
    const observed = await manageCatalogPreparationJob(authority, {
      action: 'status',
      actorId: command.actorId,
      jobId,
    });
    if (!observed.ok && observed.code === 'BUSY')
      throw Error('Preparation status is temporarily unavailable.');
    return observed.ok && 'status' in observed ? observed.status : null;
  };
  let current = await status();
  if (!current) return result('rejected');
  if (current.current && current.nextAction === 'ready') return result('complete', true);
  if (current.nextAction === 'edit' || current.progress.state === 'cancelled')
    return result('issue');
  if (current.nextAction === 'retry') {
    if (command.retries >= 3) return result('issue');
    const retried = await manageCatalogPreparationJob(authority, {
      action: 'retry',
      actorId: command.actorId,
      jobId,
      expectedLeaseVersion: current.progress.leaseVersion,
    });
    if (!retried.ok) return result(retried.code === 'FORBIDDEN' ? 'rejected' : 'waiting');
    command.retries++;
    current = await status();
    if (!current) return result('rejected');
  }
  if (current.nextAction !== 'continue') return result('waiting');
  const dispatch = await manageCatalogPreparationJob(authority, {
    action: 'dispatch',
    actorId: command.actorId,
    jobId,
  });
  if (!dispatch.ok) return result(dispatch.code === 'FORBIDDEN' ? 'rejected' : 'waiting');
  if (!('call' in dispatch) || !authority.verifyCall(dispatch.call)) return result('rejected');
  try {
    await (options.execute ?? runCatalogPreparationCall)(authority, dispatch.call);
  } catch (error) {
    current = await status();
    if (current?.current && current.nextAction === 'ready') return result('complete', true);
    throw error;
  }
  // Read the persisted, current report; a worker acknowledgement alone never means ready.
  current = await status();
  if (!current) return result('rejected');
  if (current.current && current.nextAction === 'ready') return result('complete', true);
  if (current.nextAction === 'edit' || current.progress.state === 'cancelled')
    return result('issue');
  return result(current.nextAction === 'continue' ? 'continue' : 'waiting');
}
