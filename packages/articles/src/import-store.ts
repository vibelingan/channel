import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { parseArticleDraft } from './draft-repository.ts';
import { createArticleDraft } from './drafts.ts';
import { ArticleImportError, importHash, prepareArticleImport } from './import.ts';
import type { ArticleStore, ArticleStoreTransaction } from './transaction-store.ts';
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integrationSchema = z
  .object({
    _id: identity,
    siteId: z.literal('supplychainsai.com'),
    integrationId: identity,
    secretDigest: hash,
    enabled: z.boolean(),
    expiresAt: z.string().datetime(),
    configRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const importSchema = z
  .object({
    _id: z.string(),
    siteId: z.literal('supplychainsai.com'),
    integrationId: identity,
    keyId: identity,
    requestHash: hash,
    source: z.unknown(),
    converterVersion: z.literal('article-import-v1'),
    articleId: z.string(),
    importedRevision: z.literal(1),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ArticleIntegration = z.infer<typeof integrationSchema>;
export interface ArticleImportReceipt {
  operationId: string;
  articleId: string;
  state: 'ready';
  importedRevision: 1;
  createdAt: string;
  editUrl: string;
  operationUrl: string;
  replayed: boolean;
}
const denied = (code: ArticleImportError['code'], message: string, retryAfterSeconds?: number) => ({
  failure: new ArticleImportError(code, message, retryAfterSeconds),
});
const unauthorized = () => denied('UNAUTHORIZED', 'Draft integration is unavailable.');
function parseCredential(credential: string) {
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,47})\.([a-f0-9]{64})$/.exec(credential);
  if (!match?.[1] || !match[2]) throw unauthorized().failure;
  return { keyId: match[1], digest: createHash('sha256').update(match[2]).digest('hex') };
}
async function authorized(
  store: ArticleStore,
  credential: ReturnType<typeof parseCredential>,
  now: number,
): Promise<ArticleIntegration | null> {
  const parsed = integrationSchema.safeParse(
    await store.read('articleIntegrations', credential.keyId),
  );
  if (!parsed.success) return null;
  const key = parsed.data;
  return key._id === credential.keyId &&
    key.enabled &&
    Date.parse(key.expiresAt) > now &&
    timingSafeEqual(Buffer.from(key.secretDigest, 'hex'), Buffer.from(credential.digest, 'hex'))
    ? key
    : null;
}
function receipt(row: z.infer<typeof importSchema>, replayed: boolean): ArticleImportReceipt {
  return {
    operationId: row._id,
    articleId: row.articleId,
    state: 'ready',
    importedRevision: row.importedRevision,
    createdAt: row.createdAt,
    editUrl: `https://supplychainsai.com/admin/?section=articles&article=${row.articleId}`,
    operationUrl: `/api/integrations/v1/article-drafts/${row._id}`,
    replayed,
  };
}
async function validateStored(
  store: ArticleStore,
  value: unknown,
  key: ArticleIntegration,
): Promise<z.infer<typeof importSchema>> {
  const row = importSchema.parse(value);
  if (
    row.integrationId !== key.integrationId ||
    row.requestHash !== importHash(row.source) ||
    !/^article-import-[a-f0-9]{64}$/.test(row._id) ||
    row.articleId !== row._id.replace('article-import-', 'article-')
  )
    throw Error('Invalid import identity');
  const draftRow = await store.read('articleDrafts', row.articleId);
  if (
    !draftRow ||
    typeof draftRow !== 'object' ||
    Array.isArray(draftRow) ||
    Reflect.get(draftRow, '_id') !== row.articleId
  )
    throw Error('Imported draft unavailable');
  const draft = parseArticleDraft(Reflect.get(draftRow, 'draft'));
  if (draft.id !== row.articleId || draft.createdBy !== `integration:${key.integrationId}`)
    throw Error('Imported draft identity differs');
  return row;
}
async function writeRow(
  store: ArticleStore,
  collection: string,
  row: Record<string, unknown> & { _id: string },
) {
  const { _id, ...body } = row;
  await store.write(collection, _id, body);
}
/** Service credentials can create drafts and read their own receipts. There is no publication capability. */
export function createArticleImportService(
  transaction: ArticleStoreTransaction,
  clock = Date.now,
  limits = { minute: 10, day: 100 },
) {
  if (
    !Number.isSafeInteger(limits.minute) ||
    limits.minute < 1 ||
    limits.minute > 10 ||
    !Number.isSafeInteger(limits.day) ||
    limits.day < 1 ||
    limits.day > 100
  )
    throw Error('Invalid import limits');
  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof ArticleImportError) throw e;
      throw new ArticleImportError('UNAVAILABLE', 'Draft storage could not be confirmed.');
    }
  }
  return {
    create: (credential: string, input: unknown) =>
      safe(async () => {
        const auth = parseCredential(credential);
        const key = await transaction((store) => authorized(store, auth, clock()));
        if (!key) throw unauthorized().failure;
        const prepared = prepareArticleImport(input);
        const operationId = `article-import-${importHash(['supplychainsai.com', key.integrationId, prepared.source.idempotencyKey])}`;
        const articleId = operationId.replace('article-import-', 'article-');
        const outcome = await transaction(async (store) => {
          const now = clock();
          const current = await authorized(store, auth, now);
          if (
            !current ||
            current.integrationId !== key.integrationId ||
            current.configRevision !== key.configRevision
          )
            return unauthorized();
          const existing = await store.read('articleImports', operationId);
          if (existing !== null) {
            const row = await validateStored(store, existing, current);
            if (row._id !== operationId || row.requestHash !== prepared.requestHash)
              return denied(
                'CONFLICT',
                'This draft request was already used for different content.',
              );
            return { value: receipt(row, true) };
          }
          if ((await store.read('articleDrafts', articleId)) !== null)
            return denied('CONFLICT', 'The draft identity is already occupied.');
          const counters = [];
          for (const [kind, ms, max] of [
            ['minute', 60000, limits.minute],
            ['day', 86400000, limits.day],
          ] as const) {
            const id = `limit-${importHash([current.integrationId, kind])}`;
            const window = Math.floor(now / ms);
            const before = await store.read('articleImportLimits', id);
            const parsed = z
              .object({
                _id: z.literal(id),
                integrationId: z.literal(current.integrationId),
                kind: z.literal(kind),
                window: z.number().int().nonnegative(),
                count: z.number().int().nonnegative(),
              })
              .strict()
              .nullable()
              .parse(before);
            if (parsed && parsed.window > window) throw Error('Import clock moved backwards');
            const count = parsed?.window === window ? parsed.count : 0;
            if (count >= max)
              return denied(
                'RATE_LIMITED',
                'Draft creation limit reached.',
                Math.ceil(((window + 1) * ms - now) / 1000),
              );
            counters.push({
              _id: id,
              integrationId: current.integrationId,
              kind,
              window,
              count: count + 1,
            });
          }
          const nowIso = new Date(now).toISOString();
          const actor = `integration:${current.integrationId}`;
          const draft = createArticleDraft({
            id: articleId,
            editorId: actor,
            now: nowIso,
            content: prepared.content,
          });
          const row = {
            _id: operationId,
            siteId: 'supplychainsai.com' as const,
            integrationId: current.integrationId,
            keyId: current._id,
            requestHash: prepared.requestHash,
            source: prepared.source,
            converterVersion: prepared.converterVersion,
            articleId,
            importedRevision: 1 as const,
            createdAt: nowIso,
          };
          await writeRow(store, 'articleDrafts', {
            _id: articleId,
            draft,
            requestActorId: actor,
            requestId: prepared.source.idempotencyKey,
            requestHash: importHash(prepared.content),
            searchTitle: prepared.content.title.toLowerCase(),
          });
          await writeRow(store, 'articleImports', row);
          for (const counter of counters) await writeRow(store, 'articleImportLimits', counter);
          return { value: receipt(row, false) };
        });
        if ('failure' in outcome) throw outcome.failure;
        return outcome.value;
      }),
    get: (credential: string, operationId: string) =>
      safe(async () => {
        const auth = parseCredential(credential);
        if (!/^article-import-[a-f0-9]{64}$/.test(operationId))
          throw denied('NOT_FOUND', 'Draft import not found.').failure;
        const outcome = await transaction(async (store) => {
          const current = await authorized(store, auth, clock());
          if (!current) return unauthorized();
          const value = await store.read('articleImports', operationId);
          if (
            !value ||
            typeof value !== 'object' ||
            Reflect.get(value, 'integrationId') !== current.integrationId
          )
            return denied('NOT_FOUND', 'Draft import not found.');
          const row = await validateStored(store, value, current);
          if (row._id !== operationId) throw Error('Import operation differs');
          return { value: receipt(row, true) };
        });
        if ('failure' in outcome) throw outcome.failure;
        return outcome.value;
      }),
  };
}
