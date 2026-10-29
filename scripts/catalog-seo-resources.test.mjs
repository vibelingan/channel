import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOG_SEO_NOSQL_RESOURCES,
  ensureCatalogSeoNoSqlResources,
} from './catalog-seo-resources.mjs';
import { REQUIRED_NOSQL_RESOURCES } from './cloudbase-nosql-resources.mjs';

function fixture({ failReadback = false } = {}) {
  const collections = new Set();
  const permissions = new Map();
  const indexes = new Map();
  const calls = [];
  const call = (name, args) => {
    calls.push({ name, args });
    if (args.action === 'checkCollection')
      return { success: true, exists: collections.has(args.collectionName) };
    if (args.action === 'createCollection') {
      collections.add(args.collectionName);
      return { success: true };
    }
    if (args.action === 'listIndexes')
      return { success: true, indexes: indexes.get(args.collectionName) ?? [] };
    if (args.action === 'updateCollection') {
      indexes.set(
        args.collectionName,
        args.updateOptions.CreateIndexes.map((index) => ({
          Name: index.IndexName,
          Unique: index.MgoKeySchema.MgoIsUnique,
          Keys: index.MgoKeySchema.MgoIndexKeys,
        })),
      );
      return { success: true };
    }
    if (args.action === 'getResourcePermission')
      return { success: true, aclTag: permissions.get(args.resourceId) ?? 'READONLY' };
    if (args.action === 'updateResourcePermission') {
      if (!failReadback) permissions.set(args.resourceId, args.permission);
      return { success: true };
    }
    throw new Error(`Unexpected test call: ${name}`);
  };
  return { collections, permissions, calls, call };
}

test('SEO resources are explicit function-only collections outside the default deploy manifest', () => {
  assert.deepEqual(
    CATALOG_SEO_NOSQL_RESOURCES.map((item) => item.collectionName),
    ['catalogSeoRequests', 'catalogSeoTasks', 'catalogPublicHeads'],
  );
  assert.ok(
    CATALOG_SEO_NOSQL_RESOURCES.every(
      (item) =>
        item.permission === 'ADMINONLY' &&
        item.indexes.length ===
          (['catalogSeoRequests', 'catalogSeoTasks'].includes(item.collectionName) ? 1 : 0),
    ),
  );
  assert.equal(
    REQUIRED_NOSQL_RESOURCES.some((item) =>
      ['catalogSeoRequests', 'catalogSeoTasks', 'catalogPublicHeads'].includes(item.collectionName),
    ),
    false,
  );
});

test('explicit SEO preparation creates only its collections and verifies permissions by reading back', () => {
  const current = fixture();
  ensureCatalogSeoNoSqlResources(current.call, () => {});
  assert.deepEqual(
    [...current.collections],
    CATALOG_SEO_NOSQL_RESOURCES.map((item) => item.collectionName),
  );
  assert.ok([...current.permissions.values()].every((value) => value === 'ADMINONLY'));
  assert.equal(
    current.calls.filter((item) => item.args.action === 'getResourcePermission').length,
    6,
  );
  assert.ok(
    current.calls.every((item) =>
      (item.args.collectionName ?? item.args.resourceId).startsWith('catalog'),
    ),
  );
  const before = current.calls.length;
  ensureCatalogSeoNoSqlResources(current.call, () => {});
  assert.equal(
    current.calls
      .slice(before)
      .some((item) => /createCollection|updateResourcePermission/.test(item.args.action)),
    false,
  );
});

test('resolved permission updates do not pass when the readback still exposes client access', () => {
  const current = fixture({ failReadback: true });
  assert.throws(
    () => ensureCatalogSeoNoSqlResources(current.call, () => {}),
    /expected ADMINONLY permission/,
  );
});
