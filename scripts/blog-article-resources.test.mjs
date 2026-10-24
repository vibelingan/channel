import assert from 'node:assert/strict';
import test from 'node:test';
import { ARTICLE_NOSQL_RESOURCES, ensureArticleNoSqlResources } from './blog-article-resources.mjs';
import { REQUIRED_NOSQL_RESOURCES } from './cloudbase-nosql-resources.mjs';

function fixture({ failReadback = false } = {}) {
  const collections = new Set();
  const permissions = new Map();
  const calls = [];
  const call = (name, args) => {
    calls.push({ name, args });
    if (args.action === 'checkCollection')
      return { success: true, exists: collections.has(args.collectionName) };
    if (args.action === 'createCollection') {
      collections.add(args.collectionName);
      return { success: true };
    }
    if (args.action === 'listIndexes') return { success: true, indexes: [] };
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

test('article resources are explicit function-only collections outside the default deploy manifest', () => {
  assert.deepEqual(
    ARTICLE_NOSQL_RESOURCES.map((item) => item.collectionName),
    [
      'articleDrafts',
      'articlePublications',
      'articleSlugs',
      'articleMedia',
      'articleReleaseTasks',
      'articleReleaseHeads',
      'articleAccepted',
    ],
  );
  assert.ok(
    ARTICLE_NOSQL_RESOURCES.every(
      (item) => item.permission === 'ADMINONLY' && item.indexes.length === 0,
    ),
  );
  assert.equal(
    REQUIRED_NOSQL_RESOURCES.some((item) => item.collectionName.startsWith('article')),
    false,
  );
});

test('explicit article preparation creates only its collections and verifies permissions by reading back', () => {
  const current = fixture();
  ensureArticleNoSqlResources(current.call, () => {});
  assert.deepEqual(
    [...current.collections],
    ARTICLE_NOSQL_RESOURCES.map((item) => item.collectionName),
  );
  assert.ok([...current.permissions.values()].every((value) => value === 'ADMINONLY'));
  assert.equal(
    current.calls.filter((item) => item.args.action === 'getResourcePermission').length,
    14,
  );
  assert.ok(
    current.calls.every((item) =>
      (item.args.collectionName ?? item.args.resourceId).startsWith('article'),
    ),
  );
  const before = current.calls.length;
  ensureArticleNoSqlResources(current.call, () => {});
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
    () => ensureArticleNoSqlResources(current.call, () => {}),
    /expected ADMINONLY permission/,
  );
});
