import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';

async function fixture(t: { after(fn: () => void): void }, legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-withdrawal-barrier-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const header = {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'p',
    name: 'Clock',
    images: ['/api/images/image'],
    facts: [],
    offers: [],
  };
  const product: CollectionDoc = {
    _id: 'p',
    name: 'Clock',
    description: '',
    imageIds: ['image'],
    productFamily: 'misc',
    subcategoryIds: ['clock'],
    ...(legacy ? {} : { published: false }),
    archived: false,
    detailSourceReady: true,
    detailSourceOwner: 'alibaba:source',
    detailSourceRevision: 'source-r1',
    detailSourceCandidate: header,
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    catalogDetailPublication: { state: 'approved', revision: 'old', header, variantCount: 0 },
    updatedAt: '2026-10-13T00:00:00.000Z',
  };
  writeFileSync(
    file,
    JSON.stringify({
      products: [product],
      users: [{ _id: 'admin', role: 'admin' }],
      images: [
        { _id: 'image', status: 'active', storageProvider: 'local-disk', publishedRefCount: 0 },
      ],
    }),
  );
  let adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const config = { jwtSecret: 'owned-withdrawal-test-only', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Test Admin',
    email: 'admin@example.test',
  });
  const admin = (action: string, data: unknown) =>
    handleAdminRequest({ action, token, data }, config);
  const approval = (data: unknown) => admin('catalogDetailApproval', data);
  const review = await approval({ action: 'review', productId: 'p' });
  assert.ok(review.ok, JSON.stringify(review));
  const reviewed = z
    .object({ expectedDigest: z.string(), expectedRevision: z.string().nullable() })
    .parse(review.data);
  const start = await approval({
    action: 'begin',
    command: { productId: 'p', operationId: randomUUID(), ...reviewed },
  });
  assert.ok(start.ok, JSON.stringify(start));
  const job = z.object({ jobId: z.string(), pages: z.number() }).parse(start.data);
  assert.equal(job.pages, 0);
  return {
    file,
    product,
    admin,
    approval,
    job,
    row: () => JSON.parse(readFileSync(file, 'utf8')).products[0] as CollectionDoc,
    restart: () => {
      adapter = new JsonFileAdapter(file);
      setAdapter(adapter);
      return adapter;
    },
  };
}

for (const legacy of [false, true])
  for (const writer of ['admin', 'raw-update'] as const)
    test(`explicit Disable survives restart and cancels old approval: ${writer}, legacy=${legacy}`, async (t) => {
      const f = await fixture(t, legacy);
      const seed = JSON.parse(readFileSync(f.file, 'utf8'));
      if (writer === 'admin') {
        const saved = await f.admin('update', {
          collection: 'products',
          id: 'p',
          values: { published: false },
          expectedUpdatedAt: f.product.updatedAt,
        });
        assert.ok(saved.ok, JSON.stringify(saved));
      } else await f.restart().update('products', 'p', { published: false });
      f.restart();
      const beforeFinish = readFileSync(f.file, 'utf8');
      const result = await f.approval({ action: 'finish', jobId: f.job.jobId });
      assert.ok(!result.ok, JSON.stringify(result));
      assert.equal(result.error.code, 'CONFLICT');
      assert.equal(readFileSync(f.file, 'utf8'), beforeFinish);
      const final = JSON.parse(beforeFinish);
      assert.equal(f.row().catalogLifecycleVersion, 1);
      assert.equal(f.row().published, false);
      assert.deepEqual(f.row().subcategoryIds, ['clock']);
      assert.deepEqual(f.row().catalogDetailPublication, f.product.catalogDetailPublication);
      assert.deepEqual(final.images, seed.images);
      assert.deepEqual(final.catalogDetailApprovals, seed.catalogDetailApprovals);
    });

test('ordinary source capture metadata does not cancel an otherwise unchanged approval', async (t) => {
  const f = await fixture(t);
  // Capture metadata is server-owned; the actual sync uses the adapter, not admin CRUD.
  const result = await f
    .restart()
    .update('products', 'p', { alibabaSourceLastSyncedAt: '2026-10-18T00:00:00.000Z' });
  assert.ok(result);
  f.restart();
  const finished = await f.approval({ action: 'finish', jobId: f.job.jobId });
  assert.ok(finished.ok, JSON.stringify(finished));
  assert.equal(f.row().published, false);
  assert.equal(Object.hasOwn(f.row(), 'catalogLifecycleVersion'), false);
});

test('completed approval remains history after Disable and cannot satisfy an old guarded publish', async (t) => {
  const f = await fixture(t);
  const finished = await f.approval({ action: 'finish', jobId: f.job.jobId });
  assert.ok(finished.ok, JSON.stringify(finished));
  const approved = f.row();
  const disabled = await f.admin('update', {
    collection: 'products',
    id: 'p',
    values: { published: false },
    expectedUpdatedAt: approved.updatedAt,
  });
  assert.ok(disabled.ok, JSON.stringify(disabled));
  f.restart();
  const before = readFileSync(f.file, 'utf8');
  const historical = await f.approval({ action: 'finish', jobId: f.job.jobId });
  assert.ok(historical.ok, JSON.stringify(historical));
  const stale = await f.admin('update', {
    collection: 'products',
    id: 'p',
    values: { published: true },
    expectedUpdatedAt: approved.updatedAt,
  });
  assert.ok(!stale.ok, JSON.stringify(stale));
  assert.equal(stale.error.code, 'CONFLICT');
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(f.row().published, false);
  assert.deepEqual(f.row().catalogDetailApprovalReceipt, approved.catalogDetailApprovalReceipt);
});
