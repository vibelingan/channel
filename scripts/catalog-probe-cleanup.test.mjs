import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupCatalogProbe } from './catalog-probe-cleanup.mjs';
const run = '40910382710';
const owned = [`seo_probe_${run}_products`, `seo_probe_${run}_tasks`];
function fixture() {
  const rows = new Set([...owned, 'products', 'catalogSeoTasks']);
  const fns = new Set([`seo-catalog-probe-${run}`, 'admin']);
  const calls = [];
  const events = [];
  let fail;
  let partial = false;
  const manager = {
    getManagerConfig: () => ({ envId: 'diversity-123-d9grnqfux221323bb', region: 'ap-shanghai' }),
    database: {
      listCollections: async () => ({
        Collections: [...rows]
          .slice(0, partial ? 1 : rows.size)
          .map((CollectionName) => ({ CollectionName })),
        Pager: { Offset: 0, Total: rows.size },
      }),
      deleteCollection: async (name) => {
        calls.push(name);
        if (fail === 'deny')
          throw Object.assign(Error('denied'), { code: 'UnauthorizedOperation' });
        rows.delete(name);
        if (fail === 'lost') {
          fail = undefined;
          throw Object.assign(Error('lost reply'), {
            code: 'FailedOperation.Timeout',
            requestId: 'actual-request',
          });
        }
      },
    },
    functions: {
      listFunctions: async () => [...fns].map((FunctionName) => ({ FunctionName })),
      deleteFunction: async (name) => {
        calls.push(name);
        fns.delete(name);
      },
    },
  };
  return {
    manager,
    calls,
    rows,
    fns,
    events,
    options: {
      manager,
      run,
      owned,
      functionCreated: true,
      onEvent: async (event) => events.push(event),
      wait: async () => {},
    },
    fail: (value) => {
      fail = value;
    },
    partial: () => {
      partial = true;
    },
  };
}
test('a timed-out deletion that actually completed is read back and never repeated', async () => {
  const f = fixture();
  f.fail('lost');
  const result = await cleanupCatalogProbe(f.options);
  assert.equal(result.cleaned, true);
  assert.equal(f.calls.filter((name) => name === owned[0]).length, 1);
  assert.ok(
    f.events.some((row) => row.errorCode === 'FailedOperation.Timeout' && row.removed === true),
  );
  assert.deepEqual([...f.rows], ['products', 'catalogSeoTasks']);
  assert.deepEqual([...f.fns], ['admin']);
});
test('cleanup is idempotent and never deletes a resource outside the exact run prefix', async () => {
  const f = fixture();
  await cleanupCatalogProbe(f.options);
  const count = f.calls.length;
  await cleanupCatalogProbe(f.options);
  assert.equal(f.calls.length, count);
  await assert.rejects(cleanupCatalogProbe({ ...f.options, owned: ['products'] }), /ownership/);
});
test('incomplete readback stops cleanup instead of treating an unseen resource as absent', async () => {
  const f = fixture();
  f.partial();
  await assert.rejects(cleanupCatalogProbe(f.options), /Complete cleanup inventory/);
  assert.ok(f.rows.has(owned[0]));
  assert.ok(!f.calls.includes(owned[0]));
});
test('permission rejection preserves the test table and stops without blind retries', async () => {
  const f = fixture();
  f.fail('deny');
  await assert.rejects(cleanupCatalogProbe(f.options), /refused/);
  assert.ok(f.rows.has(owned[0]));
  assert.equal(f.calls.filter((name) => name === owned[0]).length, 1);
});

test('complete multi-page resource inventories remain safe above the first hundred entries', async () => {
  const f = fixture();
  for (let i = 0; i < 205; i++) f.rows.add(`existing-table-${i}`);
  for (let i = 0; i < 105; i++) f.fns.add(`existing-function-${i}`);
  f.manager.database.listCollections = async ({ MgoLimit, MgoOffset }) => ({
    Collections: [...f.rows]
      .slice(MgoOffset, MgoOffset + MgoLimit)
      .map((CollectionName) => ({ CollectionName })),
    Pager: { Offset: MgoOffset, Total: f.rows.size },
  });
  f.manager.functions.listFunctions = async (limit, offset) =>
    [...f.fns].slice(offset, offset + limit).map((FunctionName) => ({ FunctionName }));
  await cleanupCatalogProbe(f.options);
  assert.equal(f.rows.size, 207);
  assert.equal(f.fns.size, 106);
});

test('an acknowledged asynchronous function deletion is polled without submitting delete twice', async () => {
  const f = fixture();
  let pendingReads = 0;
  f.manager.functions.deleteFunction = async (name) => {
    f.calls.push(name);
    pendingReads = 4;
  };
  f.manager.functions.listFunctions = async () => {
    if (pendingReads > 0 && --pendingReads === 0) f.fns.delete(`seo-catalog-probe-${run}`);
    return [...f.fns].map((FunctionName) => ({ FunctionName }));
  };
  await cleanupCatalogProbe(f.options);
  assert.equal(f.calls.filter((name) => name === `seo-catalog-probe-${run}`).length, 1);
  assert.deepEqual([...f.fns], ['admin']);
});

test('an acknowledged deletion that remains visible stops after bounded readback without deleting again', async () => {
  const f = fixture();
  f.manager.functions.deleteFunction = async (name) => {
    f.calls.push(name);
  };
  await assert.rejects(cleanupCatalogProbe(f.options), /acknowledged but not yet confirmed/);
  assert.equal(f.calls.filter((name) => name === `seo-catalog-probe-${run}`).length, 1);
  assert.ok(f.rows.has(owned[0]));
});
