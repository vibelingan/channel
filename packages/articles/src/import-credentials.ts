import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ArticleImportError } from './import.ts';
import type { ArticleStore, ArticleStoreTransaction } from './transaction-store.ts';

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const articleIntegrationSchema = z
  .object({
    _id: identity,
    siteId: z.literal('supplychainsai.com'),
    integrationId: identity,
    secretDigest: digest,
    enabled: z.boolean(),
    expiresAt: z.string().datetime(),
    configRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ArticleIntegration = z.infer<typeof articleIntegrationSchema>;
export const managedArticlePolicySchema = z
  .object({
    _id: z.string(),
    siteId: z.literal('supplychainsai.com'),
    keyId: identity,
    integrationId: identity,
    rotateAfter: z.string().datetime(),
    previous: z
      .object({
        secretDigest: digest,
        validUntil: z.string().datetime(),
        rotationId: z.string().regex(/^[a-f0-9]{32}$/),
        fromRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
const unauthorized = () =>
  new ArticleImportError('UNAUTHORIZED', 'Draft integration is unavailable.');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const equal = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));

export const managedPolicyId = (keyId: string) => `managed-${keyId}`;
export function parseIntegrationCredential(credential: string) {
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,47})\.([a-f0-9]{64})$/.exec(credential);
  if (!match?.[1] || !match[2]) throw unauthorized();
  return { keyId: match[1], secret: match[2], digest: sha(match[2]) };
}
async function policyFor(store: ArticleStore, key: ArticleIntegration) {
  const id = managedPolicyId(key._id);
  const parsed = managedArticlePolicySchema.safeParse(await store.read('articleIntegrations', id));
  return parsed.success &&
    parsed.data._id === id &&
    parsed.data.keyId === key._id &&
    parsed.data.integrationId === key.integrationId
    ? parsed.data
    : null;
}
export async function authorizedIntegration(
  store: ArticleStore,
  credential: ReturnType<typeof parseIntegrationCredential>,
  now: number,
): Promise<ArticleIntegration | null> {
  const parsed = articleIntegrationSchema.safeParse(
    await store.read('articleIntegrations', credential.keyId),
  );
  if (!parsed.success) return null;
  const key = parsed.data;
  if (key._id !== credential.keyId || !key.enabled || !(Date.parse(key.expiresAt) > now))
    return null;
  if (equal(key.secretDigest, credential.digest)) return key;
  const policy = await policyFor(store, key);
  return policy?.previous &&
    Date.parse(policy.previous.validUntil) > now &&
    equal(policy.previous.secretDigest, credential.digest)
    ? key
    : null;
}
function rotatedSecret(secret: string, keyId: string, revision: number, rotationId: string) {
  return createHmac('sha256', secret)
    .update(JSON.stringify(['channel-article-rotation-v1', keyId, revision, rotationId]))
    .digest('hex');
}
export async function rotateArticleCredential(
  transaction: ArticleStoreTransaction,
  credential: string,
  input: unknown,
  clock = Date.now,
) {
  const auth = parseIntegrationCredential(credential);
  const parsed = z
    .object({ rotationId: z.string().regex(/^[a-f0-9]{32}$/) })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw new ArticleImportError('INVALID_REQUEST', 'Invalid credential rotation request.');
  const work = async (store: ArticleStore) => {
    const now = clock();
    const current = await authorizedIntegration(store, auth, now);
    if (!current) throw unauthorized();
    const policy = await policyFor(store, current);
    if (!policy) throw unauthorized();
    const { rotationId } = parsed.data;
    if (equal(current.secretDigest, auth.digest) && policy.previous?.rotationId === rotationId)
      return {
        credential,
        expiresAt: current.expiresAt,
        rotateAfter: policy.rotateAfter,
        configRevision: current.configRevision,
      };
    if (!equal(current.secretDigest, auth.digest)) {
      const previous = policy.previous;
      if (
        !previous ||
        previous.rotationId !== rotationId ||
        !(Date.parse(previous.validUntil) > now)
      )
        throw unauthorized();
      const secret = rotatedSecret(auth.secret, auth.keyId, previous.fromRevision, rotationId);
      if (!equal(sha(secret), current.secretDigest)) throw unauthorized();
      return {
        credential: `${auth.keyId}.${secret}`,
        expiresAt: current.expiresAt,
        rotateAfter: policy.rotateAfter,
        configRevision: current.configRevision,
      };
    }
    if (now < Date.parse(policy.rotateAfter))
      throw new ArticleImportError(
        'RATE_LIMITED',
        'Credential rotation is not due.',
        Math.ceil((Date.parse(policy.rotateAfter) - now) / 1000),
      );
    const secret = rotatedSecret(auth.secret, auth.keyId, current.configRevision, rotationId);
    const next = {
      ...current,
      secretDigest: sha(secret),
      expiresAt: new Date(now + 90 * 86400000).toISOString(),
      configRevision: current.configRevision + 1,
    };
    const nextPolicy = {
      ...policy,
      rotateAfter: new Date(now + 30 * 86400000).toISOString(),
      previous: {
        secretDigest: current.secretDigest,
        validUntil: new Date(now + 86400000).toISOString(),
        rotationId,
        fromRevision: current.configRevision,
      },
    };
    const { _id, ...body } = articleIntegrationSchema.parse(next);
    const { _id: policyId, ...policyBody } = managedArticlePolicySchema.parse(nextPolicy);
    await store.write('articleIntegrations', _id, body);
    await store.write('articleIntegrations', policyId, policyBody);
    return {
      credential: `${auth.keyId}.${secret}`,
      expiresAt: next.expiresAt,
      rotateAfter: nextPolicy.rotateAfter,
      configRevision: next.configRevision,
    };
  };
  // Expected denials leave the transaction as values, just like draft creation.
  // The DB adapter maps thrown unknown errors to storage failures.
  const outcome = await transaction(async (store) => {
    try {
      return { value: await work(store) };
    } catch (error) {
      if (error instanceof ArticleImportError) return { failure: error };
      throw error;
    }
  });
  if ('failure' in outcome) throw outcome.failure;
  return outcome.value;
}
