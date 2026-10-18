import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { manageCatalogProductOperation, setAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { createOwnedMediaPreparation } from '../../functions/admin/src/catalog-operation-media-preparation.ts';
import { manageHumanCatalogPreparation } from '../../functions/admin/src/catalog-preparation-api.ts';
import { runCatalogPreparationWorker } from '../../functions/admin/src/catalog-preparation-worker.ts';
import { JsonFileAdapter } from './json-adapter.ts';

async function fixture(t: TestContext, save = true, intent: 'publish' | 'save-draft' = 'publish') {
  const dir = mkdtempSync(join(tmpdir(), 'channel-owned-media-step-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  const at = '2026-10-19T00:00:00.000Z';
  writeFileSync(
    file,
    JSON.stringify({
      users: [
        { _id: 'admin', role: 'admin', status: 'active' },
        { _id: 'other', role: 'admin', status: 'active' },
      ],
      products: [
        {
          _id: 'p',
          name: 'Clock',
          description: 'Draft',
          productFamily: 'misc',
          imageIds: [],
          published: false,
          archived: false,
          updatedAt: at,
          catalogPricingMode: 'manual',
          manualCatalogPricing: {
            schemaVersion: 'manual-catalog-pricing-v1',
            currency: 'USD',
            tiers: [{ minQuantity: 1, unitAmountMinor: 300 }],
          },
        },
      ],
      images: [],
      productVariants: [],
      catalogDetailApprovals: [],
      catalogPreparationJobs: [],
      catalogImageObservations: [],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const started = await manageCatalogProductOperation('admin', {
    action: 'product-operation-start',
    productId: 'p',
    operationId: '11111111-1111-4111-8111-111111111111',
    intent,
    expectedUpdatedAt: at,
    values: {},
  });
  assert.ok(started.ok, JSON.stringify(started));
  const root = CatalogProductOperationStatusSchema.parse(started);
  const scope = { productId: 'p', operationId: root.operationId, inputDigest: root.inputDigest };
  if (save)
    assert.ok(
      (await manageCatalogProductOperation('admin', { ...scope, action: 'product-operation-save' }))
        .ok,
    );
  const authority = createCatalogPreparationAuthority({
    secret: 'owned-step-test',
    environmentId: 'owned-step-test',
  });
  const bytes = () => readFileSync(file, 'utf8');
  const mutate = async (change: string) => {
    if (change === 'cancel')
      assert.ok(
        (
          await manageCatalogProductOperation('admin', {
            ...scope,
            action: 'product-operation-cancel',
          })
        ).ok,
      );
    else if (change === 'edit') {
      const product = await adapter.get('products', 'p');
      assert.ok(product);
      assert.equal(
        (
          await adapter.saveCatalogProductWithIdentities({
            mode: 'update',
            productId: 'p',
            expectedUpdatedAt: typeof product.updatedAt === 'string' ? product.updatedAt : null,
            data: { description: 'Later editor' },
          })
        ).result,
        'saved',
      );
    } else {
      const rows = JSON.parse(bytes());
      rows.users[0].role = 'member';
      writeFileSync(file, JSON.stringify(rows));
    }
  };
  return { file, adapter, scope, authority, bytes, mutate };
}

test('the guarded server step completes a real zero-image worker job while the original draft remains saved', async (t) => {
  const h = await fixture(t);
  let calls = 0;
  const step = createOwnedMediaPreparation(h.authority, async (call) => {
    calls++;
    return { result: await runCatalogPreparationWorker(h.authority, call) };
  });
  const result = await step('admin', h.scope, 12000);
  assert.ok(result.ok && result.ready, JSON.stringify(result));
  assert.equal(calls, 1);
  const rows = JSON.parse(h.bytes());
  assert.equal(rows.catalogPreparationJobs.length, 1);
  assert.equal(rows.catalogPreparationJobs[0].state, 'completed');
  assert.equal(rows.catalogDetailApprovals.length, 1);
  assert.equal(rows.catalogDetailApprovals[0].state, 'saved');
  assert.equal(rows.products[0].published, false);
  const before = h.bytes();
  assert.ok((await step('admin', h.scope, 12000)).ok);
  assert.equal(calls, 1);
  assert.equal(h.bytes(), before);
});

for (const fault of [
  'wrong-product',
  'wrong-operation',
  'wrong-digest',
  'wrong-actor',
  'extra-body',
])
  test(`guarded media step rejects ${fault} without creating preparation`, async (t) => {
    const h = await fixture(t);
    let calls = 0;
    const step = createOwnedMediaPreparation(h.authority, async () => {
      calls++;
      throw Error('must not invoke');
    });
    const input = {
      ...h.scope,
      ...(fault === 'wrong-product' ? { productId: 'other-product' } : {}),
      ...(fault === 'wrong-operation'
        ? { operationId: '22222222-2222-4222-8222-222222222222' }
        : {}),
      ...(fault === 'wrong-digest' ? { inputDigest: 'f'.repeat(64) } : {}),
      ...(fault === 'extra-body' ? { prepared: {} } : {}),
    };
    const before = h.bytes();
    const result = await step(fault === 'wrong-actor' ? 'other' : 'admin', input, 12000);
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.equal(h.bytes(), before);
  });

for (const fault of ['reserved', 'save-draft', 'cancelled', 'expired', 'revoked'])
  test(`guarded media step refuses an original ${fault} operation`, async (t) => {
    const h = await fixture(
      t,
      fault !== 'reserved',
      fault === 'save-draft' ? 'save-draft' : 'publish',
    );
    if (fault === 'cancelled') await h.mutate('cancel');
    if (fault === 'revoked') await h.mutate('revoke');
    if (fault === 'expired') {
      const rows = JSON.parse(h.bytes());
      rows.catalogDetailApprovals[0].createdAt = new Date(
        Date.now() - 2 * 60 * 60 * 1000,
      ).toISOString();
      writeFileSync(h.file, JSON.stringify(rows));
    }
    const before = h.bytes();
    let calls = 0;
    const step = createOwnedMediaPreparation(h.authority, async () => {
      calls++;
      throw Error('must not invoke');
    });
    assert.equal((await step('admin', h.scope, 12000)).ok, false);
    assert.equal(calls, 0);
    assert.equal(h.bytes(), before);
  });

for (const phase of ['start', 'status', 'before-invoke', 'during-invoke'])
  for (const change of ['cancel', 'edit', 'revoke'])
    test(`original ${change} at ${phase} cannot grant owned media readiness`, async (t) => {
      const h = await fixture(t);
      let changed = false;
      let calls = 0;
      const mutate = async () => {
        if (!changed) {
          changed = true;
          await h.mutate(change);
        }
      };
      const step = createOwnedMediaPreparation(
        h.authority,
        async (call) => {
          calls++;
          if (phase === 'during-invoke') await mutate();
          return { result: await runCatalogPreparationWorker(h.authority, call) };
        },
        {
          operation: manageCatalogProductOperation,
          now: () => 0,
          human: async (...args) => {
            const command = args[2];
            const action =
              command && typeof command === 'object' ? Reflect.get(command, 'action') : null;
            if (phase === 'before-invoke' && action === 'continue') {
              const invoke = args[3];
              assert.ok(invoke);
              return manageHumanCatalogPreparation(args[0], args[1], args[2], async (call) => {
                await mutate();
                return invoke(call);
              });
            }
            const result = await manageHumanCatalogPreparation(...args);
            if (action === phase) await mutate();
            return result;
          },
        },
      );
      const result = await step('admin', h.scope, 12000);
      assert.ok(
        !result.ok && result.code === (change === 'revoke' ? 'FORBIDDEN' : 'CONFLICT'),
        JSON.stringify(result),
      );
      assert.equal(changed, true);
      assert.equal(calls, phase === 'during-invoke' ? 1 : 0);
      const rows = JSON.parse(h.bytes());
      assert.equal(rows.products[0].published, false);
      assert.equal(rows.catalogDetailApprovals[0].media, undefined);
      assert.equal(rows.catalogDetailApprovals[0].references, undefined);
    });

for (const budget of [0, 9999])
  test(`media worker has no admission with ${budget}ms headroom`, async (t) => {
    const h = await fixture(t);
    const before = h.bytes();
    let calls = 0;
    const step = createOwnedMediaPreparation(
      h.authority,
      async () => {
        calls++;
        throw Error('must not invoke');
      },
      {
        operation: manageCatalogProductOperation,
        human: manageHumanCatalogPreparation,
        now: () => 0,
      },
    );
    const result = await step('admin', h.scope, budget);
    assert.ok(
      result.ok && !result.ready && result.preparation.nextAction === 'wait',
      JSON.stringify(result),
    );
    assert.equal(result.preparation.job, null);
    assert.equal(calls, 0);
    assert.equal(h.bytes(), before);
  });

for (const phase of ['root-read', 'start', 'status', 'invoke-check'])
  test(`headroom exhausted during ${phase} starts no worker and remains resumable`, async (t) => {
    const h = await fixture(t);
    let now = 0;
    let reads = 0;
    let calls = 0;
    const invoke = async (call: Parameters<typeof runCatalogPreparationWorker>[1]) => {
      calls++;
      return { result: await runCatalogPreparationWorker(h.authority, call) };
    };
    const step = createOwnedMediaPreparation(h.authority, invoke, {
      now: () => now,
      operation: async (...args) => {
        const result = await manageCatalogProductOperation(...args);
        reads++;
        if ((phase === 'root-read' && reads === 1) || (phase === 'invoke-check' && reads === 4))
          now = 3000;
        return result;
      },
      human: async (...args) => {
        const result = await manageHumanCatalogPreparation(...args);
        const command = args[2];
        if (command && typeof command === 'object' && Reflect.get(command, 'action') === phase)
          now = 3000;
        return result;
      },
    });
    const result = await step('admin', h.scope, 12000);
    assert.ok(
      result.ok && !result.ready && result.preparation.nextAction === 'wait',
      JSON.stringify(result),
    );
    assert.equal(calls, 0);
    const resumed = createOwnedMediaPreparation(h.authority, invoke, {
      operation: manageCatalogProductOperation,
      human: manageHumanCatalogPreparation,
      now: () => 0,
    });
    assert.ok((await resumed('admin', h.scope, 12000)).ok);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(h.bytes()).catalogPreparationJobs.length, 1);
  });

test('original binding is captured before the first owned status lookup yields', async (t) => {
  const h = await fixture(t);
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  const step = createOwnedMediaPreparation(
    h.authority,
    async (call) => ({ result: await runCatalogPreparationWorker(h.authority, call) }),
    {
      now: () => 0,
      human: manageHumanCatalogPreparation,
      operation: async (...args) => {
        if (first) {
          first = false;
          entered();
          await held;
        }
        return manageCatalogProductOperation(...args);
      },
    },
  );
  const input = { ...h.scope };
  const pending = step('admin', input, 12000);
  await seen;
  Object.assign(input, { productId: 'other', inputDigest: 'f'.repeat(64) });
  release();
  const result = await pending;
  assert.ok(result.ok && result.ready, JSON.stringify(result));
  assert.equal(JSON.parse(h.bytes()).catalogPreparationJobs[0].productId, 'p');
});

for (const phase of ['operation', 'start', 'status'])
  test(`unknown ${phase} I/O cannot be reported as pending media progress`, async (t) => {
    const h = await fixture(t);
    let invocations = 0;
    const step = createOwnedMediaPreparation(
      h.authority,
      async () => {
        invocations++;
        throw Error('must not invoke');
      },
      {
        now: () => 0,
        operation: async (...args) => {
          if (phase === 'operation') throw Error('owned lookup unavailable');
          return manageCatalogProductOperation(...args);
        },
        human: async (...args) => {
          const command = args[2];
          if (command && typeof command === 'object' && Reflect.get(command, 'action') === phase)
            throw Error('child lookup unavailable');
          return manageHumanCatalogPreparation(...args);
        },
      },
    );
    await assert.rejects(step('admin', h.scope, 12000), /unavailable/);
    assert.equal(invocations, 0);
    assert.equal(JSON.parse(h.bytes()).products[0].published, false);
  });

for (const fault of ['start-product', 'start-job', 'status-product', 'status-job'])
  test(`guarded media rejects mismatched native ${fault} scope`, async (t) => {
    const h = await fixture(t);
    let invocations = 0;
    const step = createOwnedMediaPreparation(
      h.authority,
      async () => {
        invocations++;
        throw Error('must not invoke');
      },
      {
        operation: manageCatalogProductOperation,
        now: () => 0,
        human: async (...args) => {
          const result = structuredClone(await manageHumanCatalogPreparation(...args));
          const command = args[2];
          const action =
            command && typeof command === 'object' ? Reflect.get(command, 'action') : null;
          if (result.ok && 'progress' in result && action === 'start' && fault.startsWith('start'))
            Reflect.set(
              result.progress,
              fault.endsWith('product') ? 'productId' : 'jobId',
              'other',
            );
          if (result.ok && 'status' in result && action === 'status' && fault.startsWith('status'))
            Reflect.set(
              result.status.progress,
              fault.endsWith('product') ? 'productId' : 'jobId',
              'other',
            );
          return result;
        },
      },
    );
    const result = await step('admin', h.scope, 12000);
    assert.ok(!result.ok && result.code === 'CONFLICT', JSON.stringify(result));
    assert.equal(invocations, 0);
    assert.equal(JSON.parse(h.bytes()).products[0].published, false);
  });
