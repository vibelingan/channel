import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseArticleContent } from './article.ts';
import { ArticleValidationError } from './document.ts';
import { ArticleDraftError, parseArticleDraft } from './draft-repository.ts';
import { type ArticleCandidate, prepareArticlePublication } from './drafts.ts';
import {
  type ActiveArticleMedia,
  ArticleMediaRecordSchema,
  articleIdentity,
  articleImageIds,
} from './media.ts';
import { articleMediaPath, parsePublishedArticle } from './publication.ts';
import {
  ArticleReleaseRequestSchema,
  ArticleReleaseViewSchema,
  type ArticleReleases,
  articleReleaseActive,
  releaseHash,
  releaseTime,
} from './release.ts';
import type { ArticleStore, ArticleStoreTransaction } from './transaction-store.ts';

const count = z.number().int().positive().safe();
const reference = z
  .object({
    revision: count,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    contentHash: releaseHash,
    publishedAt: releaseTime,
    modifiedAt: releaseTime,
  })
  .strict();
const headSchema = z
  .object({
    articleId: articleIdentity,
    sequence: count,
    taskId: articleIdentity,
    stableSlug: reference.shape.slug,
    firstPublishedAt: releaseTime.nullable(),
    published: reference.nullable(),
  })
  .strict();
const taskSchema = ArticleReleaseViewSchema.extend({
  actorId: articleIdentity,
  requestHash: releaseHash,
  sequence: count,
  contentHash: releaseHash.nullable(),
  slug: reference.shape.slug,
  publishedAt: releaseTime,
  modifiedAt: releaseTime,
  media: z.array(ArticleMediaRecordSchema.options[1]).max(20),
  attempt: z.number().int().nonnegative().safe(),
  workerId: articleIdentity.nullable(),
  leaseUntil: z.number().int().nonnegative().safe(),
  receipt: z
    .object({ deliveryId: articleIdentity, artifactHash: releaseHash, acceptedAt: releaseTime })
    .strict()
    .nullable(),
}).strict();
export type ArticleReleaseTask = z.infer<typeof taskSchema>;
export interface ArticleReleaseGuard {
  taskId: string;
  workerId: string;
  attempt: number;
}
type Receipt = NonNullable<ArticleReleaseTask['receipt']>;
export interface ClaimedArticleRelease {
  guard: ArticleReleaseGuard;
  task: ArticleReleaseTask;
  candidate: ArticleCandidate | null;
}
export interface ArticleReleaseWorker extends ArticleReleases {
  claim(taskId: string, workerId: string): Promise<ClaimedArticleRelease>;
  renew(guard: ArticleReleaseGuard): Promise<void>;
  markDeploying(guard: ArticleReleaseGuard): Promise<void>;
  complete(
    guard: ArticleReleaseGuard,
    receipt: Receipt,
  ): Promise<z.infer<typeof ArticleReleaseViewSchema>>;
  failBuild(guard: ArticleReleaseGuard): Promise<void>;
  markUnknown(guard: ArticleReleaseGuard): Promise<void>;
}

function conflict(message: string): never {
  throw new ArticleDraftError('CONFLICT', message);
}
function plain(value: unknown): Record<string, unknown> {
  return z.record(z.unknown()).parse(value);
}
async function row(store: ArticleStore, collection: string, id: string) {
  const value = await store.read(collection, id);
  if (value === null) return null;
  const { _id, ...body } = plain(value);
  if (_id !== id) throw new Error('Article release record identity mismatch');
  return body;
}
async function admin(store: ArticleStore, actorId: string) {
  articleIdentity.parse(actorId);
  const user = await row(store, 'users', actorId);
  if (!user || user.status === 'suspended')
    throw new ArticleDraftError('UNAUTHORIZED', 'This session is no longer valid.');
  if (user.role !== 'admin')
    throw new ArticleDraftError('FORBIDDEN', 'Admin permission is required.');
}
function view(task: ArticleReleaseTask) {
  const { id, articleId, operation, revision, state, requestedAt, updatedAt, error } = task;
  return ArticleReleaseViewSchema.parse({
    id,
    articleId,
    operation,
    revision,
    state,
    requestedAt,
    updatedAt,
    error,
  });
}
async function write(
  store: ArticleStore,
  collection: string,
  id: string,
  value: Record<string, unknown>,
) {
  if (Buffer.byteLength(JSON.stringify(value)) > 384 * 1024)
    throw new ArticleDraftError('VALIDATION_ERROR', 'Article release record exceeds 384 KiB.');
  await store.write(collection, id, value);
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Worker methods are server capabilities. The admin API exposes request/latest only. */
export function createArticleReleaseStore(
  transaction: ArticleStoreTransaction,
  clock = Date.now,
): ArticleReleaseWorker {
  const leaseMs = 180_000;
  const now = () => {
    const value = clock();
    releaseTime.parse(new Date(value).toISOString());
    return value;
  };
  async function load(store: ArticleStore, taskId: string) {
    articleIdentity.parse(taskId);
    const raw = await row(store, 'articleReleaseTasks', taskId);
    if (!raw) throw new ArticleDraftError('NOT_FOUND', 'Article release task was not found.');
    const task = taskSchema.parse(raw);
    const head = headSchema.parse(await row(store, 'articleReleaseHeads', task.articleId));
    if (task.id !== taskId || head.articleId !== task.articleId)
      throw new Error('Article release identity mismatch');
    return { task, head };
  }
  function owner(
    task: ArticleReleaseTask,
    head: z.infer<typeof headSchema>,
    guard: ArticleReleaseGuard,
    time: number,
  ) {
    if (
      head.taskId !== task.id ||
      head.sequence !== task.sequence ||
      task.id !== guard.taskId ||
      task.workerId !== guard.workerId ||
      task.attempt !== guard.attempt ||
      time >= task.leaseUntil
    )
      conflict('The article release worker lease is no longer current.');
  }
  async function candidate(
    store: ArticleStore,
    task: ArticleReleaseTask,
  ): Promise<ArticleCandidate | null> {
    if (task.operation === 'withdraw') return null;
    const raw = await row(store, 'articlePublications', `${task.articleId}:${task.revision}`);
    const frozen = z.object({ candidate: z.unknown() }).strict().parse(raw).candidate;
    const data = z
      .object({
        articleId: z.literal(task.articleId),
        revision: z.literal(task.revision),
        content: z.unknown(),
        contentHash: z.literal(task.contentHash),
        frozenAt: releaseTime,
      })
      .strict()
      .parse(frozen);
    const draft = parseArticleDraft({
      id: task.articleId,
      revision: task.revision,
      content: data.content,
      createdAt: data.frozenAt,
      updatedAt: data.frozenAt,
      createdBy: task.actorId,
      updatedBy: task.actorId,
      published: null,
    });
    const checked = prepareArticlePublication(draft, data.frozenAt);
    if (checked.contentHash !== task.contentHash || checked.content.slug !== task.slug)
      throw new Error('Frozen article content changed');
    return checked;
  }
  return {
    request: (actorId, input) =>
      transaction(async (store) => {
        const request = ArticleReleaseRequestSchema.parse(input);
        await admin(store, actorId);
        const id = `release-${digest([actorId, request.requestId])}`;
        const requestHash = digest([
          request.operation,
          request.articleId,
          request.expectedRevision,
        ]);
        const existing = await row(store, 'articleReleaseTasks', id);
        if (existing) {
          const task = taskSchema.parse(existing);
          if (task.id !== id || task.actorId !== actorId || task.requestHash !== requestHash)
            conflict('This request ID was already used for another article release.');
          return view(task);
        }
        const storedDraft = await row(store, 'articleDrafts', request.articleId);
        if (!storedDraft) throw new ArticleDraftError('NOT_FOUND', 'Article draft was not found.');
        const draft = parseArticleDraft(storedDraft.draft);
        if (draft.id !== request.articleId) throw new Error('Article draft identity mismatch');
        if (draft.revision !== request.expectedRevision)
          conflict('The draft changed. Save or reload before publishing.');
        const previous = await row(store, 'articleReleaseHeads', request.articleId);
        const head = previous ? headSchema.parse(previous) : null;
        let lastTaskTime: string | null = null;
        if (head) {
          const active = taskSchema.parse(await row(store, 'articleReleaseTasks', head.taskId));
          lastTaskTime = active.updatedAt;
          if (active.articleId !== draft.id || active.sequence !== head.sequence)
            throw new Error('Article release head mismatch');
          if (articleReleaseActive(active.state))
            conflict('An article release is already in progress or requires a check.');
        }
        if (JSON.stringify(draft.published) !== JSON.stringify(head?.published ?? null))
          throw new Error('Article publication reference mismatch');
        const time = new Date(now()).toISOString();
        if (time < draft.updatedAt || (lastTaskTime && time < lastTaskTime))
          throw new Error('Article release clock moved backwards');
        let frozen: ArticleCandidate | null = null;
        if (request.operation === 'publish') {
          try {
            frozen = prepareArticlePublication(draft, time);
          } catch (error) {
            if (error instanceof ArticleValidationError)
              throw new ArticleDraftError(
                'VALIDATION_ERROR',
                'Check the article title, author, URL and body before publishing.',
              );
            throw error;
          }
        }
        if (head && frozen && frozen.content.slug !== head.stableSlug)
          conflict('Changing a published URL requires a redirect plan.');
        if (frozen && head?.published?.contentHash === frozen.contentHash)
          conflict('This saved content is already published.');
        if (!frozen && !head?.published) conflict('This article is not published.');
        const slug = frozen?.content.slug ?? head?.stableSlug;
        if (!slug) throw new Error('Article release slug is missing');
        const slugOwner = await row(store, 'articleSlugs', slug);
        if (slugOwner && slugOwner.articleId !== draft.id)
          conflict('This article URL belongs to another article.');
        const previousCandidate = frozen
          ? await row(store, 'articlePublications', `${draft.id}:${draft.revision}`)
          : null;
        if (
          previousCandidate &&
          plain(previousCandidate.candidate).contentHash !== frozen?.contentHash
        )
          throw new Error('Immutable publication changed');
        const media: ActiveArticleMedia[] = [];
        for (const mediaId of frozen
          ? articleImageIds(parseArticleContent(frozen.content).body)
          : []) {
          const rawImage = await row(store, 'articleMedia', mediaId);
          if (!rawImage)
            throw new ArticleDraftError(
              'VALIDATION_ERROR',
              'Complete every owned article image before publishing.',
            );
          const image = ArticleMediaRecordSchema.parse(rawImage);
          if (image.id !== mediaId || image.articleId !== draft.id || image.status !== 'active')
            throw new ArticleDraftError(
              'VALIDATION_ERROR',
              'Complete every owned article image before publishing.',
            );
          articleMediaPath(image.id, {
            mimeType: image.mimeType,
            sha256: image.checksumSha256,
            byteSize: image.byteSize,
            width: image.width,
            height: image.height,
          });
          media.push(image);
        }
        const sequence = count.parse((head?.sequence ?? 0) + 1);
        const task = taskSchema.parse({
          id,
          articleId: draft.id,
          operation: request.operation,
          revision: draft.revision,
          state: 'QUEUED',
          requestedAt: time,
          updatedAt: time,
          error: null,
          actorId,
          requestHash,
          sequence,
          contentHash: frozen?.contentHash ?? head?.published?.contentHash,
          slug,
          publishedAt: head?.firstPublishedAt ?? time,
          modifiedAt: time,
          media,
          attempt: 0,
          workerId: null,
          leaseUntil: 0,
          receipt: null,
        });
        if (frozen && !previousCandidate)
          await write(store, 'articlePublications', `${draft.id}:${draft.revision}`, {
            candidate: frozen,
          });
        if (!slugOwner) await write(store, 'articleSlugs', slug, { articleId: draft.id });
        await write(store, 'articleReleaseTasks', id, task);
        await write(
          store,
          'articleReleaseHeads',
          draft.id,
          headSchema.parse({
            articleId: draft.id,
            sequence,
            taskId: id,
            stableSlug: slug,
            firstPublishedAt: head?.firstPublishedAt ?? null,
            published: head?.published ?? null,
          }),
        );
        return view(task);
      }),
    latest: (actorId, articleId) =>
      transaction(async (store) => {
        articleIdentity.parse(articleId);
        await admin(store, actorId);
        const raw = await row(store, 'articleReleaseHeads', articleId);
        if (!raw) return null;
        const head = headSchema.parse(raw);
        const { task } = await load(store, head.taskId);
        if (task.articleId !== articleId || task.sequence !== head.sequence)
          throw new Error('Article release head mismatch');
        return view(task);
      }),
    claim: async (taskId, workerId) => {
      articleIdentity.parse(workerId);
      const result = await transaction(async (store) => {
        const { task, head } = await load(store, taskId);
        const time = now();
        if (head.taskId !== task.id || head.sequence !== task.sequence)
          conflict('This article release is no longer current.');
        if (task.state === 'DEPLOYING' && task.leaseUntil <= time) {
          await write(store, 'articleReleaseTasks', task.id, {
            ...task,
            state: 'UNKNOWN',
            error: 'CHECK_REQUIRED',
            updatedAt: new Date(time).toISOString(),
          });
          return null;
        }
        if (task.state !== 'QUEUED' && !(task.state === 'BUILDING' && task.leaseUntil <= time))
          conflict('This task is already claimed or needs a check.');
        await admin(store, task.actorId);
        const frozen = await candidate(store, task);
        const next = taskSchema.parse({
          ...task,
          state: 'BUILDING',
          attempt: task.attempt + 1,
          workerId,
          leaseUntil: time + leaseMs,
          updatedAt: new Date(time).toISOString(),
        });
        await write(store, 'articleReleaseTasks', task.id, next);
        return {
          task: next,
          candidate: frozen,
          guard: { taskId, workerId, attempt: next.attempt },
        };
      });
      if (!result)
        conflict('Cloud delivery may have started; check the live result before continuing.');
      return result;
    },
    renew: (guard) =>
      transaction(async (store) => {
        const { task, head } = await load(store, guard.taskId);
        const time = now();
        owner(task, head, guard, time);
        if (!['BUILDING', 'DEPLOYING'].includes(task.state))
          conflict('This task cannot renew its lease.');
        await write(store, 'articleReleaseTasks', task.id, {
          ...task,
          leaseUntil: time + leaseMs,
          updatedAt: new Date(time).toISOString(),
        });
      }),
    markDeploying: (guard) =>
      transaction(async (store) => {
        const { task, head } = await load(store, guard.taskId);
        const time = now();
        owner(task, head, guard, time);
        if (task.state !== 'BUILDING') conflict('This task is not ready to deploy.');
        await admin(store, task.actorId);
        await write(store, 'articleReleaseTasks', task.id, {
          ...task,
          state: 'DEPLOYING',
          leaseUntil: time + leaseMs,
          updatedAt: new Date(time).toISOString(),
        });
      }),
    complete: (guard, input) =>
      transaction(async (store) => {
        const receipt = taskSchema.shape.receipt.unwrap().parse(input);
        const { task, head } = await load(store, guard.taskId);
        if (task.state === 'SUCCEEDED') {
          if (
            task.workerId !== guard.workerId ||
            task.attempt !== guard.attempt ||
            JSON.stringify(task.receipt) !== JSON.stringify(receipt)
          )
            conflict('The completion receipt does not match.');
          return view(task);
        }
        const time = now();
        owner(task, head, guard, time);
        if (
          task.state !== 'DEPLOYING' ||
          receipt.acceptedAt < task.updatedAt ||
          receipt.acceptedAt > new Date(time).toISOString()
        )
          conflict('Delivery acceptance has not been confirmed.');
        const raw = await row(store, 'articleDrafts', task.articleId);
        if (!raw) throw new Error('Article draft disappeared during delivery');
        const draft = parseArticleDraft(raw.draft);
        if (
          draft.id !== task.articleId ||
          draft.revision < task.revision ||
          JSON.stringify(draft.published) !== JSON.stringify(head.published)
        )
          throw new Error('Article publication reference changed');
        const frozen = await candidate(store, task);
        // Read the accepted row before writes to keep the CloudBase transaction contract.
        await row(store, 'articleAccepted', task.articleId);
        const publication = frozen
          ? parsePublishedArticle({
              status: 'accepted',
              deliveryId: receipt.deliveryId,
              articleId: task.articleId,
              revision: task.revision,
              contentHash: frozen.contentHash,
              content: frozen.content,
              publishedAt: task.publishedAt,
              modifiedAt: task.modifiedAt,
              acceptedAt: receipt.acceptedAt,
              media: Object.fromEntries(
                task.media.map((m) => [
                  m.id,
                  {
                    mimeType: m.mimeType,
                    sha256: m.checksumSha256,
                    byteSize: m.byteSize,
                    width: m.width,
                    height: m.height,
                  },
                ]),
              ),
            })
          : null;
        const published = publication
          ? reference.parse({
              revision: publication.revision,
              slug: task.slug,
              contentHash: publication.contentHash,
              publishedAt: publication.publishedAt,
              modifiedAt: publication.modifiedAt,
            })
          : null;
        const next = taskSchema.parse({
          ...task,
          state: 'SUCCEEDED',
          updatedAt: new Date(time).toISOString(),
          receipt,
        });
        await write(store, 'articleDrafts', task.articleId, {
          ...raw,
          draft: parseArticleDraft({ ...draft, published }),
        });
        await write(store, 'articleAccepted', task.articleId, { publication, taskId: task.id });
        await write(store, 'articleReleaseHeads', task.articleId, {
          ...head,
          published,
          firstPublishedAt: head.firstPublishedAt ?? publication?.publishedAt ?? null,
        });
        await write(store, 'articleReleaseTasks', task.id, next);
        return view(next);
      }),
    failBuild: (guard) =>
      transaction(async (store) => {
        const { task, head } = await load(store, guard.taskId);
        const time = now();
        owner(task, head, guard, time);
        if (task.state !== 'BUILDING')
          conflict('A possibly deployed task cannot be marked as a build failure.');
        await write(store, 'articleReleaseTasks', task.id, {
          ...task,
          state: 'FAILED',
          error: 'BUILD_FAILED',
          updatedAt: new Date(time).toISOString(),
        });
      }),
    markUnknown: (guard) =>
      transaction(async (store) => {
        const { task, head } = await load(store, guard.taskId);
        // An expired worker may flag its own uncertain write, but may not touch a newer attempt.
        if (
          head.taskId !== task.id ||
          head.sequence !== task.sequence ||
          task.workerId !== guard.workerId ||
          task.attempt !== guard.attempt ||
          task.state !== 'DEPLOYING'
        )
          conflict('This task is not the current deployment.');
        await write(store, 'articleReleaseTasks', task.id, {
          ...task,
          state: 'UNKNOWN',
          error: 'CHECK_REQUIRED',
          updatedAt: new Date(now()).toISOString(),
        });
      }),
  };
}
