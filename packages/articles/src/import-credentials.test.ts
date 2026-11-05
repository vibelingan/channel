import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  authorizedIntegration,
  parseIntegrationCredential,
  rotateArticleCredential,
} from './import-credentials.ts';
import type { ArticleStore, ArticleStoreTransaction } from './transaction-store.ts';

const secret = 'f'.repeat(64);
const credential = `formal-key.${secret}`;
const now = Date.parse('2026-10-27T00:00:00Z');
const rotationId = 'a'.repeat(32);
function fixture() {
  const rows = new Map<string, unknown>();
  const store: ArticleStore = {
    read: async (_collection, id) => structuredClone(rows.get(id) ?? null),
    write: async (_collection, id, value) => {
      rows.set(id, { ...structuredClone(value), _id: id });
    },
  };
  rows.set('formal-key', {
    _id: 'formal-key',
    siteId: 'supplychainsai.com',
    integrationId: 'formal-connection',
    enabled: true,
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    expiresAt: new Date(now + 86400000 * 90).toISOString(),
    configRevision: 1,
  });
  rows.set('managed-formal-key', {
    _id: 'managed-formal-key',
    siteId: 'supplychainsai.com',
    keyId: 'formal-key',
    integrationId: 'formal-connection',
    rotateAfter: new Date(now).toISOString(),
  });
  let clock = now;
  const transaction: ArticleStoreTransaction = async (work) => work(store);
  return {
    rows,
    store,
    transaction,
    time: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
test('a managed key rotates, lost-response retry returns the same key, and no plaintext is stored', async () => {
  const f = fixture();
  const result = await rotateArticleCredential(f.transaction, credential, { rotationId }, f.time);
  assert.notEqual(result.credential, credential);
  assert.equal(Date.parse(result.expiresAt) - now, 90 * 86400000);
  assert.equal(Date.parse(result.rotateAfter) - now, 30 * 86400000);
  assert.deepEqual(
    await rotateArticleCredential(f.transaction, credential, { rotationId }, f.time),
    result,
  );
  assert.deepEqual(
    await rotateArticleCredential(f.transaction, result.credential, { rotationId }, f.time),
    result,
  );
  assert.equal(
    JSON.stringify([...f.rows.values()]).includes(result.credential.split('.')[1] ?? ''),
    false,
  );
  assert(await authorizedIntegration(f.store, parseIntegrationCredential(credential), f.time()));
  assert(
    await authorizedIntegration(f.store, parseIntegrationCredential(result.credential), f.time()),
  );
  assert.deepEqual(
    await rotateArticleCredential(f.transaction, result.credential, { rotationId }, f.time),
    result,
  );
  await assert.rejects(
    rotateArticleCredential(
      f.transaction,
      result.credential,
      { rotationId: 'b'.repeat(32) },
      f.time,
    ),
  );
  f.advance(86400000 + 1);
  assert.equal(
    await authorizedIntegration(f.store, parseIntegrationCredential(credential), f.time()),
    null,
  );
  assert(
    await authorizedIntegration(f.store, parseIntegrationCredential(result.credential), f.time()),
  );
});
test('revocation blocks both generations and prevents renewal; a pilot key cannot self-upgrade', async () => {
  const f = fixture();
  const next = await rotateArticleCredential(f.transaction, credential, { rotationId }, f.time);
  const row = f.rows.get('formal-key');
  assert(row && typeof row === 'object');
  f.rows.set('formal-key', { ...row, enabled: false });
  for (const key of [credential, next.credential]) {
    assert.equal(
      await authorizedIntegration(f.store, parseIntegrationCredential(key), f.time()),
      null,
    );
    await assert.rejects(rotateArticleCredential(f.transaction, key, { rotationId }, f.time));
  }
  f.rows.set('formal-key', { ...row, enabled: true });
  f.rows.delete('managed-formal-key');
  await assert.rejects(
    rotateArticleCredential(f.transaction, next.credential, { rotationId: 'b'.repeat(32) }, f.time),
  );
});
test('expiry and caller-controlled lifetime, identity and malformed rotation IDs fail closed', async () => {
  const f = fixture();
  for (const input of [
    { rotationId: 'short' },
    { rotationId, expiresAt: '2099-01-01T00:00:00Z' },
    { rotationId, integrationId: 'other' },
  ])
    await assert.rejects(rotateArticleCredential(f.transaction, credential, input, f.time));
  f.advance(91 * 86400000);
  await assert.rejects(rotateArticleCredential(f.transaction, credential, { rotationId }, f.time));
});
