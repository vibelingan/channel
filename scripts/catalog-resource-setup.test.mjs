import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_SEO_NOSQL_RESOURCES } from './catalog-seo-resources.mjs';
import { prepareCatalogResources } from './release/catalog-resource-setup.mjs';
function setup() {
  const collections = new Set(['products', 'productVariants', 'catalogDetailVariants']);
  const indexes = new Map();
  const permissions = new Map();
  const writes = [];
  const manager = {
    database: {
      listCollections: async ({ MgoLimit, MgoOffset }) => ({
        Collections: [...collections]
          .slice(MgoOffset, MgoOffset + MgoLimit)
          .map((CollectionName) => ({ CollectionName })),
        Pager: { Total: collections.size, Offset: MgoOffset },
      }),
      createCollection: async (name) => {
        collections.add(name);
        writes.push(['create', name]);
      },
      describeCollection: async (name) => ({ Indexes: indexes.get(name) ?? [] }),
      updateCollection: async (name, options) => {
        assert.equal(Object.hasOwn(options, 'DropIndexes'), false);
        writes.push(['index', name, options]);
        indexes.set(name, [
          ...(indexes.get(name) ?? []),
          ...options.CreateIndexes.map((i) => ({
            Name: i.IndexName,
            Unique: i.MgoKeySchema.MgoIsUnique,
            Keys: i.MgoKeySchema.MgoIndexKeys,
          })),
        ]);
      },
    },
    permission: {
      modifyResourcePermission: async (input) => {
        permissions.set(input.resource, input.permission);
        writes.push(['permission', input]);
      },
      describeResourcePermission: async ({ resources }) => ({
        Data: {
          PermissionList: resources.map((Resource) => ({
            Resource,
            Permission: permissions.get(Resource),
          })),
        },
      }),
    },
  };
  return { manager, collections, indexes, permissions, writes };
}
test('resource preparation touches only owned empty collections and additive query indexes; repetition writes nothing', async () => {
  const x = setup();
  const result = await prepareCatalogResources(x.manager);
  assert.equal(result.createdCollections.length, 8);
  assert.equal(result.businessWrites, 0);
  assert.equal(result.deletedResources, 0);
  assert.ok(result.createdCollections.every((n) => n.startsWith('catalog')));
  assert.equal(result.createdIndexes.length, 5);
  const before = x.writes.length;
  await prepareCatalogResources(x.manager);
  assert.equal(x.writes.length, before);
});
test('an existing public collection is preserved and blocks preparation', async () => {
  const x = setup();
  const name = CATALOG_SEO_NOSQL_RESOURCES[0].collectionName;
  x.collections.add(name);
  x.permissions.set(name, 'PUBLICREAD');
  await assert.rejects(prepareCatalogResources(x.manager), /confirmed private/);
  assert.equal(x.writes.length, 0);
});
test('a conflicting existing index is never deleted or rewritten', async () => {
  const x = setup();
  x.indexes.set('catalogSeoRequests', [
    { Name: 'catalog_seo_request_queue', Unique: true, Keys: [] },
  ]);
  await assert.rejects(prepareCatalogResources(x.manager), /no index replaced/);
  assert.equal(x.writes.filter((w) => w[0] === 'index').length, 0);
});

test('an incomplete or failed collection inventory causes no writes', async () => {
  const x = setup();
  x.manager.database.listCollections = async () => {
    throw Error('read timed out');
  };
  await assert.rejects(prepareCatalogResources(x.manager), /read timed out/);
  assert.equal(x.writes.length, 0);
  x.manager.database.listCollections = async () => ({
    Collections: [],
    Pager: { Total: 1, Offset: 0 },
  });
  await assert.rejects(prepareCatalogResources(x.manager), /Complete resource inventory/);
  assert.equal(x.writes.length, 0);
});
