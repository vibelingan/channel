import assert from 'node:assert/strict';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { coldOwnedMedia, workspace } from './testing/catalog-operation-workspace.ts';

test('Admin image reference count reads native pending terminal proofs without settling storage', async (t) => {
  const h = await workspace(t, undefined, true);
  const media = await coldOwnedMedia(h);
  const scope = await h.start();
  const completed = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(completed.ok, JSON.stringify(completed));
  assert.equal(Reflect.get(completed.data as object, 'state'), 'complete');
  const config = { jwtSecret: 'owned-continue-test-only' };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const before = h.bytes();
  assert.equal((await h.adapter.get('images', 'image'))?.publishedRefCount, 0);
  const result = await handleAdminRequest(
    {
      action: 'getImageReferenceCount',
      token,
      data: { imageId: 'image' },
    },
    config,
  );
  assert.deepEqual(result, { ok: true, data: { imageId: 'image', state: 'counted', count: 1 } });
  assert.equal(h.bytes(), before);
  const invalid = await handleAdminRequest(
    {
      action: 'getImageReferenceCount',
      token,
      data: { imageId: 'image', action: 'settle' },
    },
    config,
  );
  assert.equal(invalid.ok, false);
  assert.equal(h.bytes(), before);
  await h.adapter.createDocWithId('images', 'legacy', { status: 'active' });
  assert.deepEqual(
    await handleAdminRequest(
      {
        action: 'getImageReferenceCount',
        token,
        data: { imageId: 'legacy' },
      },
      config,
    ),
    { ok: true, data: { imageId: 'legacy', state: 'legacy', count: null } },
  );
  const missing = await handleAdminRequest(
    {
      action: 'getImageReferenceCount',
      token,
      data: { imageId: 'missing' },
    },
    config,
  );
  assert.equal(missing.ok, false);
  const nativeRead = h.adapter.readCatalogImageReference.bind(h.adapter);
  h.adapter.readCatalogImageReference = async () => {
    throw Error('Snapshot unavailable');
  };
  const unavailable = await handleAdminRequest(
    {
      action: 'getImageReferenceCount',
      token,
      data: { imageId: 'image' },
    },
    config,
  );
  assert.equal(unavailable.ok, false); // Do not return the misleading base zero on a failed snapshot.
  h.adapter.readCatalogImageReference = nativeRead;
  const read = h.adapter.readCatalogImageReference.bind(h.adapter);
  let calls = 0;
  h.adapter.readCatalogImageReference = (command) => {
    calls++;
    return read(command);
  };
  await h.adapter.update('users', 'admin', { role: 'contributor' });
  const demoted = await handleAdminRequest(
    {
      action: 'getImageReferenceCount',
      token,
      data: { imageId: 'image' },
    },
    config,
  );
  assert.equal(demoted.ok, false);
  if (!demoted.ok) assert.equal(demoted.error.code, 'FORBIDDEN');
  assert.equal(calls, 0);
  await h.adapter.update('users', 'admin', { status: 'suspended' });
  const forbidden = await handleAdminRequest(
    {
      action: 'getImageReferenceCount',
      token,
      data: { imageId: 'image' },
    },
    config,
  );
  assert.equal(forbidden.ok, false);
  assert.equal(calls, 0);
});
