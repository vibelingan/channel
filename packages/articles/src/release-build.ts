import { prepareArticleBuild } from './build.ts';
import { parsePublishedArticle } from './publication.ts';
import type { ClaimedArticleRelease } from './release-store.ts';

/** Drops all actor/storage/lease fields before a candidate enters the static builder. */
export function articleReleaseBuildInput(
  claim: ClaimedArticleRelease,
  accepted: unknown[],
  siteOrigin: string,
) {
  const { task, candidate } = claim;
  if (
    task.state !== 'BUILDING' ||
    claim.guard.taskId !== task.id ||
    task.attempt !== claim.guard.attempt ||
    task.workerId !== claim.guard.workerId
  )
    throw new Error('Build requires the current claimed task');
  const release = {
    schemaVersion: 1,
    purpose: 'article-release',
    taskId: task.id,
    operation: task.operation,
    articleId: task.articleId,
    revision: task.revision,
    accepted: accepted.map(parsePublishedArticle),
    candidate: candidate
      ? {
          status: 'candidate',
          taskId: task.id,
          articleId: candidate.articleId,
          revision: candidate.revision,
          content: candidate.content,
          contentHash: candidate.contentHash,
          publishedAt: task.publishedAt,
          modifiedAt: task.modifiedAt,
          media: Object.fromEntries(
            task.media.map((media) => [
              media.id,
              {
                mimeType: media.mimeType,
                sha256: media.checksumSha256,
                byteSize: media.byteSize,
                width: media.width,
                height: media.height,
              },
            ]),
          ),
        }
      : null,
  };
  prepareArticleBuild(release, task.id);
  return { siteOrigin, release };
}
