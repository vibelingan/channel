import assert from 'node:assert/strict';
import test from 'node:test';
import { drillCollections, prepareDummyInitialization } from './release-drill/resources.mjs';
function fixture({ occupied = false, existing = false, permission = 'ADMINONLY' } = {}) {
  const names = new Set(existing ? drillCollections : []);
  const writes = [];
  const manager = {
    currentEnvironment: () => ({
      lazyInit: async () => {},
      getEnvId: () => 'diversity-123-d9grnqfux221323bb',
    }),
    getManagerConfig: () => ({ envId: 'diversity-123-d9grnqfux221323bb', region: 'ap-shanghai' }),
    functions: {
      listFunctions: async () => (occupied ? [{ FunctionName: 'seo-release-dummy' }] : []),
    },
    database: {
      listCollections: async () => ({
        Collections: [...names].map((CollectionName) => ({ CollectionName })),
        Pager: { Offset: 0, Limit: 100, Total: names.size },
      }),
      createCollection: async (name) => {
        writes.push(`create:${name}`);
        names.add(name);
      },
    },
    permission: {
      modifyResourcePermission: async ({ resource }) => {
        writes.push(`private:${resource}`);
      },
      describeResourcePermission: async ({ resources: [name] }) => ({
        Data: { TotalCount: 1, PermissionList: [{ Resource: name, Permission: permission }] },
      }),
    },
  };
  const coordinator = {
    status: async () => {
      if (!drillCollections.every((name) => names.has(name)))
        throw Object.assign(Error('Missing collection'), { code: 'DATABASE_COLLECTION_NOT_EXIST' });
      return { state: 'uninitialized' };
    },
  };
  return { manager, coordinator, writes, names };
}
test('first real drill prepares private collections before its first journal read', async () => {
  const f = fixture();
  await assert.rejects(f.coordinator.status(), { code: 'DATABASE_COLLECTION_NOT_EXIST' });
  const result = await prepareDummyInitialization(f.manager, f.coordinator);
  assert.equal(result.length, 5);
  assert.equal(f.writes.length, 10);
  assert(result.every((row) => row.created && row.permission === 'ADMINONLY'));
});
test('occupied function prevents collection provisioning', async () => {
  const f = fixture({ occupied: true });
  await assert.rejects(prepareDummyInitialization(f.manager, f.coordinator), /occupied/);
  assert.deepEqual(f.writes, []);
});
test('existing private collections are read without rewriting metadata', async () => {
  const f = fixture({ existing: true });
  const result = await prepareDummyInitialization(f.manager, f.coordinator);
  assert(result.every((row) => !row.created));
  assert.deepEqual(f.writes, []);
});
test('existing drill refuses restart without clearing records', async () => {
  const f = fixture({ existing: true });
  f.coordinator.status = async () => ({ state: 'idle' });
  await assert.rejects(prepareDummyInitialization(f.manager, f.coordinator), /earlier drill/);
  assert.deepEqual(f.writes, []);
});
test('unconfirmed inventory and metadata errors stop before any creation', async () => {
  for (const result of [
    { Collections: [], Pager: { Offset: 0, Total: 2 } },
    { Collections: [{ TableName: 'bad' }], Pager: { Offset: 0, Total: 1 } },
  ]) {
    const f = fixture();
    f.manager.database.listCollections = async () => result;
    await assert.rejects(prepareDummyInitialization(f.manager, f.coordinator), /inventory/);
    assert.deepEqual(f.writes, []);
  }
  const f = fixture();
  f.manager.database.listCollections = async () => {
    throw Error('Permission denied');
  };
  await assert.rejects(prepareDummyInitialization(f.manager, f.coordinator), /Permission denied/);
  assert.deepEqual(f.writes, []);
});
test('foreign existing permission is not reset to make the drill pass', async () => {
  const f = fixture({ existing: true, permission: 'READONLY' });
  await assert.rejects(prepareDummyInitialization(f.manager, f.coordinator), /private/);
  assert.deepEqual(f.writes, []);
});
