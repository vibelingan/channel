import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import type {
  AlibabaProductMutationInput,
  AlibabaProductMutationResult,
} from '@vibelingan-channel/db/adapter';
import * as cloudAdapters from '@vibelingan-channel/db/cloudbase';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { handleAlibabaSyncRequest } from '../../functions/alibaba-catalog-sync/src/handler.ts';
import {
  createDraftForSource,
  draftProductId,
  linkExistingProduct,
  setPinnedOffer,
} from '../../functions/alibaba-catalog-sync/src/linking.ts';
import {
  approveQuarantinedRun,
  computeQuarantineCandidateHash,
  snapshotQuarantineCandidate,
} from '../../functions/alibaba-catalog-sync/src/quarantine.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const NOW = '2026-09-15T10:00:00.000Z';
type Store = Record<string, CollectionDoc[]> & {
  products: [CollectionDoc];
  alibabaProductLinks: CollectionDoc[];
  alibabaSourceProducts: CollectionDoc[];
  alibabaSyncLeases: CollectionDoc[];
};

function linkFixture(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'source-a',
    sourceKey: 'source-a',
    connectionId: 'connection',
    sourceProductId: 'external-a',
    productId: 'product',
    linkedAt: NOW,
    linkedByUserId: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fixture(): Store {
  return {
    products: [
      {
        _id: 'product',
        name: 'Manual title',
        price: 88,
        vipPrice: 75,
        priceTiers: [{ quantity: 10, price: 70 }],
        imageIds: ['manual-image'],
        published: true,
        archived: false,
        catalogDetailPublication: { state: 'approved', revision: 'manual' },
        alibabaPrimarySourceKey: 'source-a',
        alibabaSourceProductId: 'external-a',
        alibabaSourceCategoryId: 'supplier-category',
        alibabaSourceImageUrls: ['supplier-image'],
        alibabaDescriptionImageUrls: ['supplier-description'],
        alibabaPrimaryOfferKey: 'offer',
        alibabaPinnedOfferKey: 'pinned',
        alibabaCatalogPricing: { mode: 'fixed', amount: 11 },
        alibabaSourceStatus: 'available',
        alibabaSourceReview: { provider: 'alibaba' },
        alibabaReviewPending: true,
        alibabaReviewedAt: NOW,
        alibabaReviewedByUserId: 'admin',
      },
    ],
    alibabaProductLinks: [linkFixture()],
    alibabaSourceProducts: ['a', 'b'].map((suffix) => ({
      _id: `source-${suffix}`,
      connectionId: 'connection',
      sourceProductId: `external-${suffix}`,
      active: true,
    })),
    alibabaSyncLeases: [
      {
        _id: 'connection',
        holder: 'worker',
        fence: 1,
        expiresAt: '2026-09-15T11:00:00.000Z',
      },
    ],
  };
}

function unlinkInput(store: Store): AlibabaProductMutationInput {
  const product = store.products[0];
  return {
    action: 'unlink',
    productId: 'product',
    now: NOW,
    expectedRevision:
      typeof product.alibabaLinkRevision === 'number' ? product.alibabaLinkRevision : 0,
    expectedPrimarySourceKey:
      typeof product.alibabaPrimarySourceKey === 'string' ? product.alibabaPrimarySourceKey : null,
    expectedLinks: store.alibabaProductLinks
      .filter((row) => row.productId === 'product')
      .map((row) => ({
        _id: row._id,
        sourceKey: String(row.sourceKey),
        connectionId: String(row.connectionId),
        sourceProductId: String(row.sourceProductId),
        productId: String(row.productId),
        linkedAt: String(row.linkedAt),
      })),
  };
}

function draftInput(claim: CollectionDoc | null = null): AlibabaProductMutationInput {
  return {
    action: 'create-draft',
    productId: 'new-draft',
    sourceKey: 'source-b',
    expectedRevision: null,
    expectedPrimarySourceKey: null,
    expectedLinks:
      claim?.productId === 'new-draft'
        ? [
            {
              _id: 'source-b',
              sourceKey: 'source-b',
              connectionId: 'connection',
              sourceProductId: 'external-b',
              productId: 'new-draft',
              linkedAt: NOW,
            },
          ]
        : [],
    expectedClaim:
      claim === null
        ? null
        : {
            _id: claim._id,
            sourceKey: String(claim.sourceKey),
            connectionId: String(claim.connectionId),
            sourceProductId: String(claim.sourceProductId),
            productId: String(claim.productId),
            linkedAt: String(claim.linkedAt),
          },
    draft: { name: 'Supplier draft', published: false, archived: false },
    now: NOW,
  };
}

function localHarness(context: TestContext, initial = fixture()) {
  const directory = mkdtempSync(join(tmpdir(), 'alibaba-identity-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(file, JSON.stringify(initial));
  const adapter = new JsonFileAdapter(file);
  return { adapter, file, read: () => JSON.parse(readFileSync(file, 'utf8')) as Store };
}

function cloudHarness(initial = fixture()) {
  let state = structuredClone(initial);
  let failWrite = Number.POSITIVE_INFINITY;
  let beforeCommit = false;
  let queue = Promise.resolve();
  const db: cloudAdapters.AlibabaProductCloudDatabase = {
    collection: (name) => ({
      where: (filter) => ({
        limit: (limit) => ({
          get: async () => ({
            data: structuredClone(
              (state[name] ?? [])
                .filter((row) => row.productId === filter.productId)
                .slice(0, limit),
            ),
          }),
        }),
      }),
    }),
    async runTransaction(operation) {
      const work = queue.then(async () => {
        const copy = structuredClone(state);
        let writes = 0;
        const result = await operation({
          collection: (name) => ({
            doc: (id) => ({
              get: async () => {
                assert.equal(writes, 0, 'all reads must precede writes');
                return {
                  data: structuredClone((copy[name] ?? []).filter((row) => row._id === id)),
                };
              },
              set: async (data) => {
                assert.ok(!Object.hasOwn(data, '_id'));
                copy[name] ??= [];
                const index = copy[name].findIndex((row) => row._id === id);
                if (index < 0) copy[name].push({ ...data, _id: id });
                else copy[name][index] = { ...data, _id: id };
                if (++writes === failWrite) throw new Error('injected write failure');
                return index < 0 ? { upserted: [{ _id: id }] } : { updated: 1 };
              },
              remove: async () => {
                const previous = copy[name]?.length ?? 0;
                copy[name] = (copy[name] ?? []).filter((row) => row._id !== id);
                if (++writes === failWrite) throw new Error('injected write failure');
                return { deleted: previous - copy[name].length };
              },
            }),
          }),
        });
        if (beforeCommit) throw new Error('injected commit failure');
        state = copy;
        return result;
      });
      queue = work.then(
        () => {},
        () => {},
      );
      return work;
    },
  };
  return {
    mutate: (input: AlibabaProductMutationInput) =>
      cloudAdapters.mutateAlibabaProductInCloud(db, input),
    read: () => structuredClone(state),
    fail: (at: number) => {
      failWrite = at;
    },
    failCommit: () => {
      beforeCommit = true;
    },
  };
}

for (const backend of ['local', 'cloud'] as const) {
  function setup(context: TestContext, initial = fixture()) {
    if (backend === 'cloud') return cloudHarness(initial);
    const local = localHarness(context, initial);
    return {
      read: local.read,
      mutate: (input: AlibabaProductMutationInput): Promise<AlibabaProductMutationResult> =>
        local.adapter.mutateAlibabaProduct(input),
    };
  }

  test(`${backend}: atomic unlink preserves manual pricing, media and publication; retry is safe`, async (context) => {
    const initial = fixture();
    const harness = setup(context, initial);
    const result = await harness.mutate(unlinkInput(initial));
    assert.deepEqual(result, { ok: true, revision: 1, clearedLinks: 1 });
    const saved = harness.read();
    assert.deepEqual(saved.alibabaProductLinks, []);
    for (const [field, value] of Object.entries(initial.products[0])) {
      if (!field.startsWith('alibaba')) assert.deepEqual(saved.products[0][field], value, field);
      else assert.equal(saved.products[0][field], null, field);
    }
    assert.equal(saved.products[0].alibabaLinkRevision, 1);
    assert.equal(saved.products[0].alibabaSourceLastSyncedAt, NOW);
    assert.deepEqual(await harness.mutate(unlinkInput(saved)), {
      ok: true,
      revision: 1,
      clearedLinks: 0,
    });
    assert.deepEqual(harness.read(), saved);
  });

  test(`${backend}: stale unlink cannot delete a relink to the same source`, async (context) => {
    const harness = setup(context);
    const stale = unlinkInput(harness.read());
    assert.equal((await harness.mutate(stale)).ok, true);
    const fresh = unlinkInput(harness.read());
    assert.equal(
      (
        await harness.mutate({
          ...fresh,
          action: 'link',
          sourceKey: 'source-a',
          linkedByUserId: 'admin',
          patch: {},
        })
      ).ok,
      true,
    );
    const relinked = harness.read();
    assert.deepEqual(await harness.mutate(stale), { ok: false, reason: 'identity-conflict' });
    assert.deepEqual(harness.read(), relinked);
  });

  test(`${backend}: stale promotion cannot restore state after unlink`, async (context) => {
    const harness = setup(context);
    const stale = unlinkInput(harness.read());
    assert.equal((await harness.mutate(stale)).ok, true);
    const unlinked = harness.read();
    const result = await harness.mutate({
      ...stale,
      action: 'promote',
      sourceKey: 'source-a',
      patch: { alibabaCatalogPricing: { mode: 'negotiable' } },
      guard: { connectionId: 'connection', holder: 'worker', fence: 1, now: NOW },
    });
    assert.deepEqual(result, { ok: false, reason: 'identity-conflict' });
    assert.deepEqual(harness.read(), unlinked);
  });

  test(`${backend}: concurrent unlink and relink have exactly one winner`, async (context) => {
    const harness = setup(context);
    const expected = unlinkInput(harness.read());
    const results = await Promise.all([
      harness.mutate(expected),
      harness.mutate({
        ...expected,
        action: 'link',
        sourceKey: 'source-b',
        linkedByUserId: 'admin',
        patch: {},
      }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(
      results.filter((result) => !result.ok && result.reason === 'identity-conflict').length,
      1,
    );
  });

  test(`${backend}: oversized or incomplete link sets fail closed`, async (context) => {
    const initial = fixture();
    initial.alibabaProductLinks = Array.from({ length: 41 }, (_, index) =>
      linkFixture({ _id: `source-${index}`, sourceKey: `source-${index}` }),
    );
    const harness = setup(context, initial);
    const expected = unlinkInput(initial);
    assert.deepEqual(await harness.mutate(expected), { ok: false, reason: 'link-limit' });
    assert.deepEqual(
      await harness.mutate({ ...expected, expectedLinks: expected.expectedLinks.slice(0, 40) }),
      { ok: false, reason: 'link-limit' },
    );
    assert.deepEqual(harness.read(), initial);
    const normal = setup(context);
    assert.deepEqual(await normal.mutate({ ...unlinkInput(normal.read()), expectedLinks: [] }), {
      ok: false,
      reason: 'identity-conflict',
    });
  });

  test(`${backend}: exactly 40 links can be removed atomically`, async (context) => {
    const initial = fixture();
    initial.alibabaProductLinks = Array.from({ length: 40 }, (_, index) =>
      linkFixture({ _id: `source-${index}`, sourceKey: `source-${index}` }),
    );
    const harness = setup(context, initial);
    assert.deepEqual(await harness.mutate(unlinkInput(initial)), {
      ok: true,
      revision: 1,
      clearedLinks: 40,
    });
    assert.deepEqual(harness.read().alibabaProductLinks, []);
  });

  test(`${backend}: changed link identity, duplicate expectations and corrupt revision write nothing`, async (context) => {
    const initial = fixture();
    const harness = setup(context, initial);
    const expected = unlinkInput(initial);
    const firstLink = expected.expectedLinks[0];
    assert.ok(firstLink);
    const changed = { ...firstLink, linkedAt: '2026-09-14T10:00:00.000Z' };
    for (const links of [[changed], [firstLink, firstLink]]) {
      assert.deepEqual(await harness.mutate({ ...expected, expectedLinks: links }), {
        ok: false,
        reason: 'identity-conflict',
      });
      assert.deepEqual(harness.read(), initial);
    }
    for (const revision of [null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER]) {
      const corrupt = fixture();
      corrupt.products[0].alibabaLinkRevision = revision;
      const invalid = setup(context, corrupt);
      assert.deepEqual(await invalid.mutate(unlinkInput(corrupt)), {
        ok: false,
        reason: 'identity-conflict',
      });
      assert.deepEqual(invalid.read(), corrupt);
    }
  });

  test(`${backend}: switching primary source preserves manual fields and drops stale supplier pricing`, async (context) => {
    const initial = fixture();
    const harness = setup(context, initial);
    const result = await harness.mutate({
      ...unlinkInput(initial),
      action: 'link',
      sourceKey: 'source-b',
      linkedByUserId: 'admin',
      patch: { alibabaSourceImageUrls: ['new-supplier-image'] },
    });
    assert.deepEqual(result, { ok: true, revision: 1, clearedLinks: 0, alreadyLinked: false });
    const saved = harness.read();
    assert.equal(saved.alibabaProductLinks.length, 2);
    assert.equal(saved.products[0].alibabaPrimarySourceKey, 'source-b');
    assert.equal(saved.products[0].alibabaCatalogPricing, null);
    assert.equal(saved.products[0].alibabaPinnedOfferKey, null);
    for (const [field, value] of Object.entries(initial.products[0])) {
      if (!field.startsWith('alibaba')) assert.deepEqual(saved.products[0][field], value, field);
    }
  });

  test(`${backend}: new drafts and both legacy claims commit product and link together`, async (context) => {
    for (const productId of [null, '', 'new-draft']) {
      const initial = fixture();
      const claim =
        productId === null
          ? null
          : linkFixture({
              _id: 'source-b',
              sourceKey: 'source-b',
              sourceProductId: 'external-b',
              productId,
            });
      if (claim) initial.alibabaProductLinks.push(claim);
      const harness = setup(context, initial);
      assert.deepEqual(await harness.mutate(draftInput(claim)), {
        ok: true,
        revision: 1,
        clearedLinks: 0,
        created: true,
      });
      const saved = harness.read();
      const draft = saved.products.find((row) => row._id === 'new-draft');
      assert.equal(draft?.published, false);
      assert.equal(draft?.alibabaLinkRevision, 1);
      assert.equal(draft?.alibabaPrimarySourceKey, 'source-b');
      assert.equal(
        saved.alibabaProductLinks.find((row) => row._id === 'source-b')?.productId,
        'new-draft',
      );
    }
  });

  test(`${backend}: stale empty claim repair cannot overwrite a concurrent relink`, async (context) => {
    const initial = fixture();
    const claim = linkFixture({
      _id: 'source-b',
      sourceKey: 'source-b',
      sourceProductId: 'external-b',
      productId: '',
    });
    const stale = draftInput(claim);
    initial.alibabaProductLinks.push({ ...claim, productId: 'another-product' });
    const harness = setup(context, initial);
    assert.deepEqual(await harness.mutate(stale), { ok: false, reason: 'identity-conflict' });
    assert.deepEqual(harness.read(), initial);
  });

  test(`${backend}: pin, reconciliation and promotion share one revision`, async (context) => {
    const initial = fixture();
    initial.alibabaSupplierOffers = [{ _id: 'offer-a', sourceKey: 'source-a', active: true }];
    const harness = setup(context, initial);
    const stale = unlinkInput(initial);
    const pin: AlibabaProductMutationInput = {
      ...stale,
      action: 'pin',
      sourceKey: 'source-a',
      offerKey: 'offer-a',
    };
    assert.equal((await harness.mutate(pin)).ok, true);
    const pinned = harness.read();
    assert.equal(pinned.products[0].alibabaLinkRevision, 1);
    assert.equal(pinned.products[0].alibabaPinnedOfferKey, 'offer-a');
    assert.deepEqual(
      await harness.mutate({
        ...stale,
        action: 'reconcile',
        sourceKey: 'source-a',
        patch: { alibabaDescriptionImageUrls: ['stale'] },
      }),
      { ok: false, reason: 'identity-conflict' },
    );
    assert.deepEqual(
      await harness.mutate({
        ...stale,
        action: 'promote',
        sourceKey: 'source-a',
        patch: {},
        guard: { connectionId: 'connection', holder: 'worker', fence: 1, now: NOW },
      }),
      { ok: false, reason: 'identity-conflict' },
    );
    assert.equal(
      (
        await harness.mutate({
          ...unlinkInput(pinned),
          action: 'reconcile',
          sourceKey: 'source-a',
          patch: { alibabaDescriptionImageUrls: ['fresh'] },
        })
      ).ok,
      true,
    );
    assert.equal(harness.read().products[0].alibabaLinkRevision, 2);
    assert.equal(harness.read().products[0].alibabaReviewedAt, NOW);
    assert.deepEqual(await harness.mutate(pin), { ok: false, reason: 'identity-conflict' });
  });

  test(`${backend}: concurrent pin or reconciliation and promotion have exactly one winner`, async (context) => {
    for (const action of ['pin', 'reconcile'] as const) {
      for (const reverse of [false, true]) {
        const harness = setup(context);
        const expected = unlinkInput(harness.read());
        const promotion: AlibabaProductMutationInput = {
          ...expected,
          action: 'promote',
          sourceKey: 'source-a',
          patch: {},
          guard: { connectionId: 'connection', holder: 'worker', fence: 1, now: NOW },
        };
        const competing: AlibabaProductMutationInput =
          action === 'pin'
            ? { ...expected, action, sourceKey: 'source-a', offerKey: '' }
            : {
                ...expected,
                action,
                sourceKey: 'source-a',
                patch: { alibabaDescriptionImageUrls: [] },
              };
        const inputs = reverse ? [competing, promotion] : [promotion, competing];
        const results = await Promise.all(inputs.map((input) => harness.mutate(input)));
        assert.equal(results.filter((result) => result.ok).length, 1);
        assert.equal(
          results.filter((result) => !result.ok && result.reason === 'identity-conflict').length,
          1,
        );
        assert.equal(harness.read().products[0].alibabaLinkRevision, 1);
      }
    }
  });

  test(`${backend}: nonprimary reconciliation cannot overwrite the primary source review`, async (context) => {
    const initial = fixture();
    initial.alibabaProductLinks.push(
      linkFixture({ _id: 'source-b', sourceKey: 'source-b', sourceProductId: 'external-b' }),
    );
    const harness = setup(context, initial);
    assert.deepEqual(
      await harness.mutate({
        ...unlinkInput(initial),
        action: 'reconcile',
        sourceKey: 'source-b',
        patch: { alibabaDescriptionImageUrls: ['wrong-source'] },
      }),
      { ok: true, revision: 0, clearedLinks: 0 },
    );
    assert.deepEqual(harness.read(), initial);
  });

  test(`${backend}: draft creation rejects existing identity and publish/manual-price patches without claims`, async (context) => {
    const initial = fixture();
    const harness = setup(context, initial);
    const input = draftInput();
    assert.equal(input.action, 'create-draft');
    if (input.action !== 'create-draft') return;
    for (const draft of [
      { ...input.draft, published: true },
      { ...input.draft, price: 10 },
    ]) {
      assert.deepEqual(await harness.mutate({ ...input, draft }), {
        ok: false,
        reason: 'invalid-patch',
      });
      assert.deepEqual(harness.read(), initial);
    }
    assert.deepEqual(
      await harness.mutate({ ...input, ...unlinkInput(initial), action: 'create-draft' }),
      { ok: false, reason: 'identity-conflict' },
    );
    assert.deepEqual(harness.read(), initial);
  });

  test(`${backend}: pin validates current offer identity and activity without writes`, async (context) => {
    for (const offer of [
      null,
      { _id: 'offer-a', sourceKey: 'source-b', active: true },
      { _id: 'offer-a', sourceKey: 'source-a', active: false },
    ]) {
      const initial = fixture();
      initial.alibabaSupplierOffers = offer ? [offer] : [];
      const harness = setup(context, initial);
      assert.deepEqual(
        await harness.mutate({
          ...unlinkInput(initial),
          action: 'pin',
          sourceKey: 'source-a',
          offerKey: 'offer-a',
        }),
        {
          ok: false,
          reason: offer?.sourceKey === 'source-a' ? 'offer-not-active' : 'offer-not-found',
        },
      );
      assert.deepEqual(harness.read(), initial);
    }
  });

  test(`${backend}: promotion authorizes with the canonical guard clock, not the write clock`, async (context) => {
    const initial = fixture();
    const harness = setup(context, initial);
    const input: AlibabaProductMutationInput = {
      ...unlinkInput(initial),
      action: 'promote',
      sourceKey: 'source-a',
      patch: { alibabaCatalogPricing: { mode: 'negotiable' } },
      guard: { connectionId: 'connection', holder: 'worker', fence: 1, now: NOW },
    };
    for (const guardNow of [
      '2026-09-15T11:00:00.000Z',
      '2026-09-15T12:00:00.000+02:00',
      '2026-09-15T10:00:00Z',
      'invalid',
    ]) {
      assert.deepEqual(
        await harness.mutate({ ...input, guard: { ...input.guard, now: guardNow } }),
        { ok: false, reason: 'fence-rejected' },
        guardNow,
      );
      assert.deepEqual(harness.read(), initial);
    }
    for (const now of ['2026-09-15T12:00:00.000+02:00', '2026-09-15T10:00:00Z', 'invalid']) {
      assert.deepEqual(await harness.mutate({ ...unlinkInput(initial), now }), {
        ok: false,
        reason: 'identity-conflict',
      });
      assert.deepEqual(harness.read(), initial);
    }
    assert.equal((await harness.mutate({ ...input, now: '2026-09-15T11:00:00.000Z' })).ok, true);
    assert.equal(harness.read().products[0].alibabaLinkRevision, 1);
  });

  test(`${backend}: promotion requires the live lease and rejects manual-field patches`, async (context) => {
    const harness = setup(context);
    const initial = harness.read();
    const input: AlibabaProductMutationInput = {
      ...unlinkInput(initial),
      action: 'promote',
      sourceKey: 'source-a',
      patch: { alibabaCatalogPricing: { mode: 'negotiable' } },
      guard: { connectionId: 'connection', holder: 'worker', fence: 1, now: NOW },
    };
    assert.deepEqual(await harness.mutate({ ...input, guard: { ...input.guard, fence: 0 } }), {
      ok: false,
      reason: 'fence-rejected',
    });
    assert.deepEqual(await harness.mutate({ ...input, patch: { price: 0 } }), {
      ok: false,
      reason: 'invalid-patch',
    });
    assert.deepEqual(harness.read(), initial);
    assert.equal((await harness.mutate(input)).ok, true);
    assert.deepEqual(harness.read().products[0].alibabaCatalogPricing, { mode: 'negotiable' });
    assert.equal(harness.read().products[0].price, 88);
  });
}

test('local: quarantine never approves a rejected product or sends a success alert', async (context) => {
  for (const reason of [
    'identity-conflict',
    'link-limit',
    'invalid-patch',
    'source-not-found',
    'fence-rejected',
  ] as const) {
    const initial = fixture();
    initial.alibabaSyncLeases = [];
    initial.alibabaSourceProducts = [
      {
        _id: 'source-a',
        connectionId: 'primary',
        sourceProductId: 'external-a',
        active: true,
        lastSeenRunId: 'run',
      },
    ];
    initial.alibabaProductLinks = [linkFixture({ connectionId: 'primary' })];
    const harness = localHarness(context, initial);
    setAdapter(harness.adapter);
    const candidateHash = computeQuarantineCandidateHash({
      runId: 'run',
      candidates: [await snapshotQuarantineCandidate('source-a')],
      tombstones: [],
    });
    await harness.adapter.createDocWithId('alibabaSyncRuns', 'run', {
      status: 'quarantined',
      mode: 'incremental',
      candidateHash,
    });
    const mutation = context.mock.method(
      harness.adapter,
      'mutateAlibabaProduct',
      async (): Promise<AlibabaProductMutationResult> => ({ ok: false, reason }),
    );
    const alerts: string[] = [];
    const result = await approveQuarantinedRun({
      runId: 'run',
      candidateHash,
      approvedByUserId: 'admin',
      now: () => NOW,
      alert: async (message) => {
        alerts.push(message);
      },
    });
    assert.deepEqual(result, {
      ok: false,
      reason:
        reason === 'fence-rejected'
          ? 'lease-busy'
          : reason === 'identity-conflict'
            ? 'superseded'
            : 'promotion-rejected',
    });
    assert.equal(mutation.mock.callCount(), 1);
    assert.equal(harness.read().alibabaSyncRuns?.[0]?.status, 'quarantined');
    assert.deepEqual(alerts, []);
    assert.deepEqual(harness.read().products, initial.products);
  }
});

test('local: API distinguishes mutation conflicts from missing products', async (context) => {
  const initial = fixture();
  initial.users = [{ _id: 'admin', role: 'admin', status: 'active' }];
  const harness = localHarness(context, initial);
  setAdapter(harness.adapter);
  const secret = 'identity-regression-test-secret-only';
  const token = await signSession(secret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  let reason: Extract<AlibabaProductMutationResult, { ok: false }>['reason'] = 'identity-conflict';
  context.mock.method(
    harness.adapter,
    'mutateAlibabaProduct',
    async (): Promise<AlibabaProductMutationResult> => ({ ok: false, reason }),
  );
  for (const action of ['linkProduct', 'unlinkProduct', 'setAlibabaPrimaryOffer']) {
    for (const failure of ['identity-conflict', 'link-limit', 'product-not-found'] as const) {
      reason = failure;
      const result = await handleAlibabaSyncRequest(
        { action, token, data: { productId: 'product', sourceKey: 'source-a', offerKey: '' } },
        { jwtSecret: secret },
      );
      assert.equal(result.ok, false);
      if (!result.ok)
        assert.equal(result.error.code, reason === 'product-not-found' ? 'NOT_FOUND' : 'CONFLICT');
    }
  }
});

test('cloud: failed draft writes and commit never leave an orphan claim', async () => {
  for (const at of [1, 2, 3]) {
    const initial = fixture();
    const harness = cloudHarness(initial);
    if (at === 3) harness.failCommit();
    else harness.fail(at);
    await assert.rejects(harness.mutate(draftInput()), /injected (write|commit) failure/);
    assert.deepEqual(harness.read(), initial);
  }
});

test('local: every linking writer uses the transaction, including draft repair and pin', async (context) => {
  const harness = localHarness(context);
  setAdapter(harness.adapter);
  for (const method of ['createDocWithId', 'update', 'remove'] as const) {
    context.mock.method(harness.adapter, method, async () => assert.fail(`bypass: ${method}`));
  }
  const result = await createDraftForSource('source-b', { now: NOW });
  assert.deepEqual(result, { ok: true, productId: draftProductId('source-b'), created: true });
  assert.equal((await createDraftForSource('source-b', { now: NOW })).ok, true);
  assert.equal((await setPinnedOffer({ productId: 'product', offerKey: '', now: NOW })).ok, true);
  assert.equal((await linkExistingProduct('source-b', 'product', { now: NOW })).ok, false);
});

test('local: both legacy claim repairs use only atomic writes', async (context) => {
  for (const productId of ['', 'legacy-missing']) {
    const initial = fixture();
    initial.alibabaProductLinks.push(
      linkFixture({
        _id: 'source-b',
        sourceKey: 'source-b',
        sourceProductId: 'external-b',
        productId,
      }),
    );
    const harness = localHarness(context, initial);
    setAdapter(harness.adapter);
    for (const method of ['createDocWithId', 'update', 'remove'] as const) {
      context.mock.method(harness.adapter, method, async () => assert.fail(`bypass: ${method}`));
    }
    const result = await createDraftForSource('source-b', { now: NOW });
    assert.deepEqual(result, {
      ok: true,
      productId: productId || draftProductId('source-b'),
      created: true,
    });
    assert.equal(
      harness.read().products.find((row) => row._id === (productId || draftProductId('source-b')))
        ?.alibabaLinkRevision,
      1,
    );
  }
});

test('local: a concurrent relink wins over stale draft repair, reconciliation and pin', async (context) => {
  for (const action of ['repair', 'reconcile', 'pin'] as const) {
    const initial = fixture();
    if (action === 'repair')
      initial.alibabaProductLinks.push(
        linkFixture({
          _id: 'source-b',
          sourceKey: 'source-b',
          sourceProductId: 'external-b',
          productId: '',
        }),
      );
    const harness = localHarness(context, initial);
    setAdapter(harness.adapter);
    const mutate = harness.adapter.mutateAlibabaProduct.bind(harness.adapter);
    let concurrent: Store | undefined;
    context.mock.method(
      harness.adapter,
      'mutateAlibabaProduct',
      async (input: AlibabaProductMutationInput) => {
        assert.equal(
          (
            await mutate({
              ...unlinkInput(harness.read()),
              action: 'link',
              sourceKey: 'source-b',
              linkedByUserId: 'admin',
              patch: {},
            })
          ).ok,
          true,
        );
        concurrent = harness.read();
        return mutate(input);
      },
    );
    const result =
      action === 'pin'
        ? await setPinnedOffer({ productId: 'product', offerKey: '', now: NOW })
        : await createDraftForSource(action === 'repair' ? 'source-b' : 'source-a', { now: NOW });
    assert.deepEqual(result, {
      ok: false,
      reason: action === 'pin' ? 'identity-conflict' : 'linked-elsewhere',
    });
    assert.deepEqual(harness.read(), concurrent);
    assert.equal(harness.read().products.length, 1);
  }
});

test('cloud: a failure at any unlink write or before commit leaves every row unchanged', async () => {
  for (const at of [1, 2, 3]) {
    const initial = fixture();
    initial.alibabaProductLinks.push(
      linkFixture({ _id: 'source-b', sourceKey: 'source-b', sourceProductId: 'external-b' }),
    );
    const harness = cloudHarness(initial);
    harness.fail(at);
    await assert.rejects(harness.mutate(unlinkInput(initial)), /injected write failure/);
    assert.deepEqual(harness.read(), initial);
  }
  const harness = cloudHarness();
  const initial = harness.read();
  harness.failCommit();
  await assert.rejects(harness.mutate(unlinkInput(initial)), /injected commit failure/);
  assert.deepEqual(harness.read(), initial);
});

test('local: failed atomic rename preserves disk and memory, then retry succeeds', async (context) => {
  const initial = fixture();
  const harness = localHarness(context, initial);
  const before = readFileSync(harness.file, 'utf8');
  const rename = context.mock.method(fs, 'renameSync', () => {
    throw new Error('injected rename failure');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      harness.adapter.mutateAlibabaProduct(unlinkInput(initial)),
      /injected rename failure/,
    );
    assert.equal(readFileSync(harness.file, 'utf8'), before);
    assert.deepEqual(await harness.adapter.get('products', 'product'), initial.products[0]);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await harness.adapter.mutateAlibabaProduct(unlinkInput(initial))).ok, true);
  assert.deepEqual(harness.read().alibabaProductLinks, []);
  assert.equal(
    (await new JsonFileAdapter(harness.file).get('products', 'product'))?.alibabaPrimarySourceKey,
    null,
  );
});
