import assert from 'node:assert/strict';
import test from 'node:test';
import CloudBase from '@cloudbase/manager-node';
import { ARTICLE_NOSQL_RESOURCES } from './blog-article-resources.mjs';
import { ensureFormalArticleResources } from './blog/resources.mjs';
function setup() {
  const state = {
    tables: new Map(),
    permissions: new Map(),
    calls: [],
    failRead: false,
    ignorePermission: false,
  };
  const manager = new CloudBase({
    envId: 'fixture-env',
    requestFn: async ({ action, payload }) => {
      state.calls.push({ action, payload: structuredClone(payload) });
      if (action === 'DescribeEnvInfo')
        return {
          EnvInfo: {
            EnvBaseInfo: {
              EnvId: 'fixture-env',
              Storages: [],
              Databases: [{ InstanceId: 'fixture-db' }],
              StaticStorages: [],
            },
          },
        };
      assert.equal(payload.EnvId, 'fixture-env');
      const name = payload.TableName ?? payload.Resource ?? payload.Resources?.[0];
      assert(ARTICLE_NOSQL_RESOURCES.some((resource) => resource.collectionName === name));
      if (action === 'DescribeTable') {
        if (state.failRead) throw Object.assign(new Error('Denied'), { code: 'AuthFailure' });
        if (!state.tables.has(name))
          throw Object.assign(new Error('Table not found'), { code: 'ResourceNotFound' });
        return { Indexes: structuredClone(state.tables.get(name)), RequestId: 'describe' };
      }
      if (action === 'CreateTable') {
        assert(!state.tables.has(name));
        state.tables.set(name, []);
        return { RequestId: 'create' };
      }
      if (action === 'UpdateTable') {
        state.tables.get(name).push(
          ...payload.CreateIndexes.map((i) => ({
            Name: i.IndexName,
            Unique: i.MgoKeySchema.MgoIsUnique,
            Keys: i.MgoKeySchema.MgoIndexKeys,
          })),
        );
        return { RequestId: 'index' };
      }
      if (action === 'DescribeResourcePermission')
        return {
          Data: {
            TotalCount: 1,
            PermissionList: [
              { Resource: name, Permission: state.permissions.get(name) ?? 'READONLY' },
            ],
          },
        };
      if (action === 'ModifyResourcePermission') {
        assert.equal(payload.ResourceType, 'collection');
        assert.equal(payload.Permission, 'ADMINONLY');
        if (!state.ignorePermission) state.permissions.set(name, payload.Permission);
        return { RequestId: 'permission' };
      }
      throw Error(`Unexpected SDK operation ${action}`);
    },
  });
  return { state, manager, envId: 'fixture-env' };
}
test('actual installed manager creates only seven private article collections and the exact queue and public list indexes, then becomes read-only', async () => {
  const f = setup();
  const report = await ensureFormalArticleResources(f);
  assert.equal(report.length, 7);
  assert.equal(f.state.calls.filter((c) => c.action === 'CreateTable').length, 7);
  assert.equal(f.state.calls.filter((c) => c.action === 'UpdateTable').length, 2);
  const publicIndex = f.state.tables.get('articleAccepted');
  assert.equal(publicIndex.length, 1);
  assert.deepEqual(publicIndex[0].Keys, [
    { Name: 'publication.status', Direction: '1' },
    { Name: '_id', Direction: '1' },
  ]);
  const before = f.state.calls.length;
  await ensureFormalArticleResources(f);
  assert(
    !f.state.calls
      .slice(before)
      .some((c) => ['CreateTable', 'UpdateTable', 'ModifyResourcePermission'].includes(c.action)),
  );
});
test('an authentication error cannot masquerade as a missing collection', async () => {
  const f = setup();
  f.state.failRead = true;
  await assert.rejects(ensureFormalArticleResources(f), /Denied/);
  assert(
    !f.state.calls.some((c) =>
      ['CreateTable', 'UpdateTable', 'ModifyResourcePermission'].includes(c.action),
    ),
  );
});
test('resolved permission writes still fail if the actual readback remains public', async () => {
  const f = setup();
  f.state.ignorePermission = true;
  await assert.rejects(ensureFormalArticleResources(f), /server-only/);
  assert.equal(f.state.calls.filter((c) => c.action === 'CreateTable').length, 1);
});
test('another environment cannot cause any schema or permission writes', async () => {
  const f = setup();
  await assert.rejects(ensureFormalArticleResources({ ...f, envId: 'other' }), /differs/);
  assert(
    !f.state.calls.some((c) =>
      ['CreateTable', 'UpdateTable', 'ModifyResourcePermission'].includes(c.action),
    ),
  );
});
