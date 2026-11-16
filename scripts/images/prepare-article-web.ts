import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ArticleMediaRecordSchema, articleIdentity } from '../../packages/articles/src/media.ts';
import { parsePublishedArticle } from '../../packages/articles/src/publication.ts';
import { articleTransaction } from '../../packages/db/src/article-repository.ts';
import {
  readArticleWebMedia,
  registerArticleWebMedia,
} from '../../packages/db/src/article-web-media.ts';
import { createCloudBaseMediaStorage } from '../../packages/media-storage/src/cloudbase.ts';
import { blogWorkerSdk } from '../blog/worker-source.ts';
import { prepareArticleWebMedia } from './article-web-media.ts';

const envId = 'diversity-123-d9grnqfux221323bb';
const PlanSchema = z
  .object({
    envId: z.literal(envId),
    region: z.literal('ap-shanghai'),
    articleId: articleIdentity,
    media: z
      .array(
        z
          .object({
            id: articleIdentity,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine((plan) => new Set(plan.media.map((item) => item.id)).size === plan.media.length);

interface Input {
  config: { secretId: string; secretKey: string; token?: string; envId?: string; region?: string };
  plan: unknown;
  outputDirectory: string;
}

/** Only selected derivative objects and their private ready mapping may be written. */
export async function runArticleWebPreparation(input: Input) {
  const plan = PlanSchema.parse(input.plan);
  const config = z
    .object({
      secretId: z.string().min(1),
      secretKey: z.string().min(1),
      token: z.string().min(1).optional(),
      envId: z.literal(envId).optional(),
      region: z.literal('ap-shanghai').optional(),
    })
    .strict()
    .parse(input.config);
  if (
    process.env.ARTICLE_WEB_MEDIA_CONFIRM !== 'PREPARE_SELECTED_ONLY' ||
    !input.outputDirectory?.trim()
  )
    throw Error('Explicit selected-only confirmation and private output directory required');
  const directory = resolve(input.outputDirectory);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const save = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  await save('scope.json', {
    operationId: randomUUID(),
    plan,
    originalWrites: 0,
    publicationWrites: 0,
    deletes: 0,
  });
  const sdk = blogWorkerSdk({
    env: envId,
    region: plan.region,
    secretId: config.secretId,
    secretKey: config.secretKey,
    ...(config.token ? { sessionToken: config.token } : {}),
  });
  const transaction = articleTransaction(sdk.database());
  const storage = createCloudBaseMediaStorage(sdk);
  const results = [];
  for (const target of plan.media) {
    const state = await transaction(async (store) => {
      const published = record(await store.read('articleAccepted', plan.articleId), plan.articleId);
      const article = parsePublishedArticle(published.publication);
      if (article.articleId !== plan.articleId)
        throw Error('Selected publication identity differs');
      const source = record(await store.read('articleMedia', target.id), target.id);
      const active = ArticleMediaRecordSchema.parse(source);
      if (
        active.status !== 'active' ||
        active.articleId !== plan.articleId ||
        active.checksumSha256 !== target.sha256 ||
        article.media[target.id]?.sha256 !== target.sha256
      )
        throw Error('Selected original differs from the current published article');
      return { active, article };
    });
    const existing = await transaction((store) => readArticleWebMedia(store, plan.articleId));
    await save(`${target.id}-before.json`, {
      active: state.active,
      publication: state.article,
      ready: existing?.media[target.id] ?? null,
    });
    const result = await prepareArticleWebMedia({
      active: state.active,
      existing: existing?.media[target.id],
      storage,
      checkpoint: (object) => save(`${target.id}-upload-target.json`, object),
      register: (entry) => registerArticleWebMedia(transaction, entry),
    });
    await save(`${target.id}-ready.json`, result.entry);
    results.push({
      mediaId: target.id,
      status: result.status,
      sourceBytes: result.entry.source.byteSize,
      webBytes: result.entry.web.byteSize,
      byteReads: result.byteReads,
      objectWrites: result.objectWrites,
    });
  }
  const result = {
    status: 'prepared',
    articleId: plan.articleId,
    media: results,
    originalWrites: 0,
    publicationWrites: 0,
    functionWrites: 0,
    websiteWrites: 0,
    deletes: 0,
  };
  await save('result.json', result);
  return result;
}

function record(input: unknown, id: string) {
  const { _id, ...value } = z.record(z.unknown()).parse(input);
  if (_id !== id) throw Error('Selected article record identity differs');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { readFile } = await import('node:fs/promises');
  runArticleWebPreparation({
    config: {
      secretId: process.env.TENCENTCLOUD_SECRETID ?? '',
      secretKey: process.env.TENCENTCLOUD_SECRETKEY ?? '',
      ...(process.env.TENCENTCLOUD_SESSIONTOKEN
        ? { token: process.env.TENCENTCLOUD_SESSIONTOKEN }
        : {}),
    },
    plan: JSON.parse(await readFile(process.env.ARTICLE_WEB_MEDIA_PLAN ?? '', 'utf8')),
    outputDirectory: process.env.ARTICLE_WEB_MEDIA_OUTPUT ?? '',
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        JSON.stringify({
          status: 'stopped',
          code: 'ARTICLE_WEB_PREPARATION_STOPPED',
          action: 'Inspect saved targets before retry; no objects deleted',
        }),
      );
      process.exitCode = 1;
    });
}
