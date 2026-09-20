import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import { handleAdminRequest } from '@vibelingan-channel/fn-admin/handler';
import {
  CatalogTaxonomyResultSchema,
  PRODUCT_FAMILY_OPTIONS,
  initialCatalogTaxonomy,
} from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';

test('taxonomy admin saves persist across restart and reject concurrent stale edits without changing products', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-taxonomy-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const database = new JsonFileAdapter(file);
  setAdapter(database);
  await database.create('users', { _id: 'admin', role: 'admin', status: 'active' });
  await database.create('products', {
    _id: 'protected',
    name: 'Approved product',
    productFamily: 'toys',
    published: true,
    unitPrice: 4.5,
    imageIds: ['image'],
    catalogApprovedDetail: { revision: 1 },
  });
  const before = await database.get('products', 'protected');
  const config = {
    jwtSecret: 'taxonomy-local-test-secret',
    loginUrl: 'http://localhost/login',
    resetPasswordUrl: 'http://localhost/reset',
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    name: 'Admin',
    email: 'admin@local.invalid',
    role: 'admin',
  });
  const call = async (data: unknown) => {
    const response = await handleAdminRequest({ action: 'catalogCategories', token, data }, config);
    assert.equal(response.ok, true, JSON.stringify(response));
    return CatalogTaxonomyResultSchema.parse(response.data);
  };
  for (const family of PRODUCT_FAMILY_OPTIONS) {
    const registry = initialCatalogTaxonomy(family);
    const read = await call({ kind: 'taxonomy', operation: 'read', family });
    assert.equal(read.status, 'replayed');
    assert.equal(await database.get('catalogTaxonomies', family), null);
    const result = await call({
      kind: 'taxonomy',
      operation: 'save',
      family,
      expectedRevision: 0,
      name: registry.name,
      children: [
        ...registry.children,
        { id: `${family}-new`, name: 'New child', slug: 'new-child', order: 10, status: 'active' },
      ],
    });
    assert.equal(result.status, 'configured');
    assert.ok('registry' in result);
    assert.equal(result.registry.revision, 1);
  }
  const reopened = new JsonFileAdapter(file);
  setAdapter(reopened);
  for (const family of PRODUCT_FAMILY_OPTIONS) {
    const result = await call({ kind: 'taxonomy', operation: 'read', family });
    assert.ok('registry' in result);
    assert.equal(result.registry.revision, 1);
    assert.ok(result.registry.children.some((child) => child.id === `${family}-new`));
  }
  const toys = await call({ kind: 'taxonomy', operation: 'read', family: 'toys' });
  assert.ok('registry' in toys);
  const results = await Promise.all(
    ['First edit', 'Second edit'].map((name) =>
      call({
        kind: 'taxonomy',
        operation: 'save',
        family: 'toys',
        expectedRevision: 1,
        name,
        children: toys.registry.children,
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), ['applied', 'conflict']);
  assert.deepEqual(await reopened.get('products', 'protected'), before);
  const denied = await handleAdminRequest(
    { action: 'catalogCategories', data: { kind: 'taxonomy', operation: 'read', family: 'toys' } },
    config,
  );
  assert.equal(denied.ok, false);
  const generic = await handleAdminRequest(
    { action: 'list', token, data: { collection: 'catalogTaxonomies' } },
    config,
  );
  assert.equal(generic.ok, false);
  const oversized = await handleAdminRequest(
    { action: 'catalogCategories', token, data: { kind: 'taxonomy', name: 'x'.repeat(16385) } },
    config,
  );
  assert.equal(oversized.ok, false);
  const malformed = await handleAdminRequest(
    {
      action: 'catalogCategories',
      token,
      data: { kind: 'taxonomy', operation: 'read', family: 'toys', unexpected: true },
    },
    config,
  );
  assert.equal(malformed.ok, false);
  const final = new JsonFileAdapter(file);
  assert.equal((await final.get('catalogTaxonomies', 'toys'))?.revision, 2);
  assert.deepEqual(await final.get('products', 'protected'), before);
});
