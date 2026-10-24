import { createHash, timingSafeEqual } from 'node:crypto';
import { err, ok } from '@vibelingan-channel/shared';
interface QueueConfig {
  articleQueueStatusKeyHash?: string;
  enableArticleReleases?: boolean;
  articleQueueStatus?: () => Promise<{ hasQueued: boolean; hasUnknown: boolean }>;
}
/** This credential can read only three flags. Normal user sessions remain separate. */
export async function readArticleQueueStatusRequest(
  req: { token?: string; data?: unknown },
  config: QueueConfig,
) {
  const hash = config.articleQueueStatusKeyHash;
  if (
    typeof hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    typeof req.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(req.token) ||
    !timingSafeEqual(
      Buffer.from(createHash('sha256').update(req.token).digest('hex')),
      Buffer.from(hash),
    )
  )
    return err('UNAUTHORIZED', 'Authentication required');
  if (req.data !== undefined) return err('BAD_REQUEST', 'Queue status has no data operations.');
  if (config.enableArticleReleases !== true)
    return ok({ enabled: false, hasQueued: false, hasUnknown: false });
  if (!config.articleQueueStatus) return err('INTERNAL_ERROR', 'Queue status is not configured.');
  const status = await config.articleQueueStatus();
  if (typeof status.hasQueued !== 'boolean' || typeof status.hasUnknown !== 'boolean')
    return err('INTERNAL_ERROR', 'Queue status is unavailable.');
  return ok({ enabled: true, hasQueued: status.hasQueued, hasUnknown: status.hasUnknown });
}
