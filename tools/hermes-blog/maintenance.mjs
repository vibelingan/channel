import { createHmac, randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { z } from 'zod';
import { fetchFully } from '../../scripts/smoke-http.mjs';
import { readBlogToolConfig } from './client.mjs';
import { readPrivateJson, writePrivateJson } from './credential-file.mjs';

const credential = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}\.[a-f0-9]{64}$/);
const maintenance = z
  .object({
    expiresAt: z.string().datetime(),
    rotateAfter: z.string().datetime(),
    configRevision: z.number().int().positive().safe(),
  })
  .strict();
const pendingSchema = z
  .object({
    rotationId: z.string().regex(/^[a-f0-9]{32}$/),
    previousCredential: credential,
    candidateCredential: credential,
    configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const resultSchema = maintenance.extend({ credential }).strict();

// The caller holds the publisher's OS file lock across maintenance and delivery.
export async function maintainCredentialFile(
  path,
  { request = fetchFully, clock = Date.now } = {},
) {
  const file = await readPrivateJson(path);
  const config = readBlogToolConfig(file.value);
  const state = maintenance.parse(file.value.CHANNEL_BLOG_MAINTENANCE);
  const pendingPath = `${path}.rotation.json`;
  let pending;
  try {
    pending = pendingSchema.parse((await readPrivateJson(pendingPath)).value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!pending && clock() < Date.parse(state.rotateAfter)) {
    if (clock() >= Date.parse(state.expiresAt)) throw Error('Website credential expired');
    return { config, ...state };
  }
  if (!pending) {
    const rotationId = randomBytes(16).toString('hex');
    const [keyId, secret] = config.credential.split('.');
    const next = createHmac('sha256', secret)
      .update(
        JSON.stringify(['channel-article-rotation-v1', keyId, state.configRevision, rotationId]),
      )
      .digest('hex');
    pending = {
      rotationId,
      previousCredential: config.credential,
      candidateCredential: `${keyId}.${next}`,
      configDigest: file.digest,
    };
    await writePrivateJson(pendingPath, pending);
  }
  if (
    pending.configDigest !== file.digest &&
    file.value.CHANNEL_BLOG_CREDENTIAL !== pending.candidateCredential
  )
    throw Error('Credential configuration changed outside this rotation');
  async function rotate(key) {
    return request(
      'POST',
      `${config.apiOrigin}/api/integrations/v1/article-drafts/credential-rotation`,
      {
        timeoutMs: 15000,
        maxBytes: 32768,
        redirect: 'error',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ rotationId: pending.rotationId })),
      },
    );
  }
  let response = await rotate(pending.candidateCredential);
  if (response.status === 401) response = await rotate(pending.previousCredential);
  if (response.status !== 200)
    throw Error(`Website credential maintenance failed (${response.status})`);
  const envelope = z
    .object({ ok: z.literal(true), data: resultSchema })
    .strict()
    .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)));
  const result = envelope.data;
  if (
    result.credential !== pending.candidateCredential ||
    !(Date.parse(result.expiresAt) > clock()) ||
    !(Date.parse(result.rotateAfter) < Date.parse(result.expiresAt)) ||
    result.configRevision < state.configRevision ||
    result.configRevision > state.configRevision + 1
  )
    throw Error('Website credential reply differs from this rotation');
  const nextState = {
    expiresAt: result.expiresAt,
    rotateAfter: result.rotateAfter,
    configRevision: result.configRevision,
  };
  await writePrivateJson(
    path,
    {
      ...file.value,
      CHANNEL_BLOG_CREDENTIAL: result.credential,
      CHANNEL_BLOG_MAINTENANCE: nextState,
    },
    file.digest,
  );
  await unlink(pendingPath);
  return {
    config: readBlogToolConfig({ ...file.value, CHANNEL_BLOG_CREDENTIAL: result.credential }),
    ...nextState,
  };
}
