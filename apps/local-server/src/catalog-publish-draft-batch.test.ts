import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CatalogProductSaveInput } from '@vibelingan-channel/db/adapter';
import { catalogApprovalDigest } from '@vibelingan-channel/db/catalog-detail-commit';
import { prepareStagedApproval } from '@vibelingan-channel/db/catalog-detail-staging';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';

const at = '2026-10-18T00:00:00.000Z';
for (const total of [20, 50, 100])
  test(`${total} synthetic publish-intent draft stages retain independent receipts across bounded batches and reopen`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'channel-publish-stage-batch-'));
    t.after(() => {
      rmSync(directory, { recursive: true, force: true });
      assert.equal(existsSync(directory), false);
    });
    const file = join(directory, 'db.json');
    const rows: Record<
      | 'users'
      | 'products'
      | 'alibabaSourceProducts'
      | 'catalogSourceObservations'
      | 'alibabaProductLinks',
      CollectionDoc[]
    > = {
      users: [{ _id: 'admin', role: 'admin' }],
      products: [],
      alibabaSourceProducts: [],
      catalogSourceObservations: [],
      alibabaProductLinks: [],
    };
    for (let index = 0; index < total; index++) {
      const productId = `p-${index}`;
      const sourceKey = `s-${index}`;
      rows.products.push({
        _id: productId,
        name: `Clock ${index}`,
        description: '',
        updatedAt: at,
        ...(index % 3 === 0 ? {} : { published: false, archived: false }),
        ...(index % 4 === 0 ? {} : { productFamily: 'misc', subcategoryIds: [] }),
        ...(index % 2 === 0 ? { alibabaPrimarySourceKey: sourceKey, alibabaLinkRevision: 1 } : {}),
      });
      if (index % 2 !== 0) continue;
      rows.alibabaSourceProducts.push({
        _id: sourceKey,
        sourceKey,
        connectionId: 'c',
        sourceProductId: `ext-${index}`,
        sourceCategoryId: '100',
        contentHash: 'a'.repeat(64),
        active: true,
      });
      rows.alibabaProductLinks.push({
        _id: sourceKey,
        sourceKey,
        connectionId: 'c',
        sourceProductId: `ext-${index}`,
        productId,
        linkedAt: at,
      });
      rows.catalogSourceObservations.push({
        _id: sourceObservationDocumentId('alibaba', sourceKey),
        sourceContentHash: 'a'.repeat(64),
        observation: {
          source: {
            provider: 'alibaba',
            sourceProductKey: sourceKey,
            externalProductId: `ext-${index}`,
            observedAt: at,
          },
          attributes: [{ name: 'Size', value: String(index) }],
        },
      });
    }
    writeFileSync(file, JSON.stringify(rows));
    const adapter = new JsonFileAdapter(file);
    const inputs: CatalogProductSaveInput[] = [];
    const rounds: number[] = [];
    for (let offset = 0; offset < total; offset += 20) {
      const group = rows.products.slice(offset, offset + 20);
      rounds.push(group.length);
      let next = 0;
      // This driver supplies four callers; production UI concurrency is a separate acceptance gate.
      const workers = await Promise.allSettled(
        Array.from({ length: 4 }, async () => {
          for (;;) {
            const position = next++;
            if (position >= group.length) return;
            const product = group[position];
            assert.ok(product);
            const index = offset + position;
            const operationId = `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`;
            const command = {
              action: 'operation-start' as const,
              productId: product._id,
              operationId,
              intent: 'publish' as const,
              expectedUpdatedAt: at,
              values: { description: `Owned publish draft ${index}` },
            };
            const reservation = await adapter.persistCatalogDetailApproval('admin', command);
            assert.ok(reservation.ok && 'record' in reservation);
            const input: CatalogProductSaveInput = {
              mode: 'update',
              productId: product._id,
              data: command.values,
              expectedUpdatedAt: at,
              expectedOperation: {
                actorId: 'admin',
                operationId,
                inputDigest: reservation.record.operation.inputDigest,
              },
            };
            assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
            inputs.push(input);
            const status = await adapter.persistCatalogDetailApproval('admin', {
              action: 'operation-get',
              productId: product._id,
              operationId,
            });
            assert.ok(status.ok && 'record' in status && status.current && status.revisionCurrent);
            assert.equal(status.record.state, 'saved');
            if (status.record.state !== 'saved') throw Error('own saved stage missing');
            assert.deepEqual(status.record.operation.base, reservation.record.operation.base);
            assert.deepEqual(
              status.record.saved.snapshot.source,
              reservation.record.operation.base.source,
            );
            assert.equal(status.record.operation.inputDigest, input.expectedOperation?.inputDigest);
          }
        }),
      );
      for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
    }
    const before = readFileSync(file, 'utf8');
    const reopened = new JsonFileAdapter(file);
    for (const input of inputs) {
      assert.equal((await reopened.saveCatalogProductWithIdentities(input)).result, 'saved');
      const actual = await reopened.get('products', input.productId);
      assert.ok(actual);
      const original = rows.products.find((row) => row._id === input.productId);
      assert.ok(original);
      assert.equal(actual.catalogLifecycleVersion, 1);
      assert.equal(actual.catalogContentGeneration, 1);
      assert.equal(actual.description, input.data.description);
      assert.equal(actual.published === true, false);
      assert.equal(actual.catalogDetailPublication, undefined);
      assert.equal(actual.catalogDetailApprovalReceipt, undefined);
      for (const key of ['published', 'archived', 'productFamily', 'subcategoryIds']) {
        assert.equal(Object.hasOwn(actual, key), Object.hasOwn(original, key));
        assert.deepEqual(actual[key], original[key]);
      }
    }
    assert.equal(
      readFileSync(file, 'utf8'),
      before,
      'reopen/read/replay performs no product/alias/receipt write',
    );
    const stored = JSON.parse(before);
    assert.equal(stored.catalogDetailApprovals.length, total);
    assert.equal(
      new Set(stored.catalogDetailApprovals.map((row: CollectionDoc) => row._id)).size,
      total,
    );
    assert.equal(
      new Set(stored.catalogDetailApprovals.map((row: CollectionDoc) => row.productId)).size,
      total,
    );
    const first = inputs[0];
    const other = inputs[1];
    assert.ok(first && other && first.expectedOperation && other.expectedOperation);
    assert.equal(
      (
        await reopened.saveCatalogProductWithIdentities({
          ...first,
          expectedOperation: {
            ...first.expectedOperation,
            operationId: other.expectedOperation.operationId,
          },
        })
      ).result,
      'stale',
    );
    assert.equal(readFileSync(file, 'utf8'), before);
    t.diagnostic(
      JSON.stringify({
        syntheticProducts: total,
        draftStageBatchSizes: rounds,
        callerConcurrency: 4,
        receipts: total,
        published: 0,
        repeatWrites: 0,
        realCloud: false,
        fullPublishFlow: false,
      }),
    );
  });

test('20 independent owned approval starts survive lost responses and four concurrent callers without publishing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-owned-approval20-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  });
  const file = join(dir, 'db.json');
  const products = Array.from({ length: 20 }, (_, i) => ({
    _id: `p-${i}`,
    name: `Clock ${i}`,
    description: '',
    productFamily: 'misc',
    subcategoryIds: [],
    published: false,
    archived: false,
    imageIds: [],
    updatedAt: at,
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'r1', variantIds: [] },
    detailSourceCandidate: {
      _id: `p-${i}`,
      name: `Clock ${i}`,
      schemaVersion: 'catalog-product-detail-v1',
      images: [],
      facts: [],
      offers: [],
    },
  }));
  writeFileSync(file, JSON.stringify({ users: [{ _id: 'admin', role: 'admin' }], products }));
  const adapter = new JsonFileAdapter(file);
  let next = 0;
  const ids = new Set<string>();
  const workers = await Promise.allSettled(
    Array.from({ length: 4 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= 20) return;
        const product = products[i];
        assert.ok(product);
        const operationId = `12345678-1234-4234-8234-${String(i).padStart(12, '0')}`;
        const command = {
          action: 'operation-start' as const,
          productId: product._id,
          operationId,
          intent: 'publish' as const,
          expectedUpdatedAt: at,
          values: {},
        };
        const first = await adapter.persistCatalogDetailApproval('admin', command);
        assert.ok(first.ok && 'record' in first);
        const input = {
          mode: 'update' as const,
          productId: product._id,
          data: {},
          expectedUpdatedAt: at,
          expectedOperation: {
            actorId: 'admin',
            operationId,
            inputDigest: first.record.operation.inputDigest,
          },
        };
        assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
        const saved = await adapter.get('products', product._id);
        assert.ok(saved);
        const prepared = prepareStagedApproval(
          'admin',
          {
            productId: product._id,
            operationId,
            expectedRevision: null,
            expectedDigest: catalogApprovalDigest(saved, []),
          },
          saved,
          [],
        );
        assert.ok(prepared.ok, JSON.stringify(prepared));
        const begin = {
          action: 'operation-approval-begin' as const,
          productId: product._id,
          operationId,
          inputDigest: first.record.operation.inputDigest,
          prepared: prepared.value,
        };
        assert.equal((await adapter.persistCatalogDetailApproval('admin', begin)).ok, true);
        const reopened = new JsonFileAdapter(file);
        const own = await reopened.persistCatalogDetailApproval('admin', {
          action: 'operation-get',
          productId: product._id,
          operationId,
        });
        assert.ok(own.ok && 'record' in own && own.current && own.revisionCurrent);
        assert.equal(own.record.state, 'staging');
        assert.equal(own.record.operationId, operationId);
        assert.equal(own.record.productId, product._id);
        ids.add(own.record._id);
        assert.equal((await reopened.saveCatalogProductWithIdentities(input)).result, 'saved');
        assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', begin), own);
      }
    }),
  );
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
  assert.equal(ids.size, 20);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.catalogDetailApprovals.length, 20);
  for (const row of stored.products) {
    assert.equal(row.published, false);
    assert.equal(row.catalogLifecycleVersion, 1);
    assert.equal(row.catalogDetailApprovalReceipt, undefined);
    assert.equal(row.catalogDetailPublication, undefined);
    assert.equal(row.productFamily, 'misc');
    assert.deepEqual(row.subcategoryIds, []);
  }
});

test('20 source-bound owned approvals retain420private configurations through two pages and four callers', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-own-pages20-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
  });
  const file = join(directory, 'db.json');
  const rows: Record<
    | 'users'
    | 'products'
    | 'productVariants'
    | 'catalogDetailVariants'
    | 'alibabaSourceProducts'
    | 'alibabaProductLinks'
    | 'catalogSourceObservations',
    CollectionDoc[]
  > = {
    users: [{ _id: 'admin', role: 'admin' }],
    products: [],
    productVariants: [],
    catalogDetailVariants: [],
    alibabaSourceProducts: [],
    alibabaProductLinks: [],
    catalogSourceObservations: [],
  };
  for (let i = 0; i < 20; i++) {
    const productId = `p-${i}`;
    const source = `s-${i}`;
    const owner = `alibaba:${source}`;
    const variants = Array.from({ length: 21 }, (_, j) => ({
      _id: `${productId}-v${j}`,
      productId,
      position: j,
      sku: `sku-${i}-${j}`,
      detailSourceOwner: owner,
      detailSourceRevision: 'r1',
      detailSourceMissing: false,
      imageIds: [],
      optionValues: { Color: String(j) },
      detailSourceCandidate: {
        id: `${productId}-v${j}`,
        options: [],
        images: [],
        offers: [],
        inventory: { state: 'unknown' },
      },
    }));
    rows.products.push({
      _id: productId,
      name: `Clock ${i}`,
      description: '',
      productFamily: 'misc',
      subcategoryIds: [],
      published: false,
      archived: false,
      imageIds: [],
      updatedAt: at,
      alibabaPrimarySourceKey: source,
      alibabaLinkRevision: 1,
      detailSourceReady: true,
      detailSourceOwner: owner,
      detailSourceRevision: 'r1',
      detailSourceContentGeneration: 0,
      detailSourceManifest: { revision: 'r1', variantIds: variants.map((v) => v._id) },
      detailSourceCandidate: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: productId,
        name: `Clock ${i}`,
        images: [],
        facts: [],
        offers: [],
      },
    });
    rows.productVariants.push(...variants);
    rows.alibabaSourceProducts.push({
      _id: source,
      sourceKey: source,
      connectionId: 'c',
      sourceProductId: `ext-${i}`,
      contentHash: 'a'.repeat(64),
      active: true,
    });
    rows.alibabaProductLinks.push({
      _id: source,
      sourceKey: source,
      connectionId: 'c',
      sourceProductId: `ext-${i}`,
      productId,
      linkedAt: at,
    });
  }
  writeFileSync(file, JSON.stringify(rows));
  const adapter = new JsonFileAdapter(file);
  let next = 0;
  const keys = new Set<string>();
  const revisions = new Set<string>();
  const workers = await Promise.allSettled(
    Array.from({ length: 4 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= 20) return;
        const productId = `p-${i}`;
        const operationId = `12345678-1234-4234-8234-${String(i).padStart(12, '0')}`;
        const start = {
          action: 'operation-start' as const,
          productId,
          operationId,
          intent: 'publish' as const,
          expectedUpdatedAt: at,
          values: {},
        };
        const first = await adapter.persistCatalogDetailApproval('admin', start);
        assert.ok(first.ok && 'record' in first);
        const input = {
          mode: 'update' as const,
          productId,
          data: {},
          expectedUpdatedAt: at,
          expectedOperation: {
            actorId: 'admin',
            operationId,
            inputDigest: first.record.operation.inputDigest,
          },
        };
        assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
        const product = await adapter.get('products', productId);
        assert.ok(product);
        const variants = rows.productVariants.filter((v) => v.productId === productId);
        const prepared = prepareStagedApproval(
          'admin',
          {
            productId,
            operationId,
            expectedRevision: null,
            expectedDigest: catalogApprovalDigest(product, variants),
          },
          product,
          variants,
        );
        assert.ok(prepared.ok);
        assert.equal(
          (
            await adapter.persistCatalogDetailApproval('admin', {
              action: 'operation-approval-begin',
              productId,
              operationId,
              inputDigest: first.record.operation.inputDigest,
              prepared: prepared.value,
            })
          ).ok,
          true,
        );
        for (const page of [0, 1]) {
          const result = await adapter.persistCatalogDetailApproval('admin', {
            action: 'operation-approval-page',
            productId,
            operationId,
            inputDigest: first.record.operation.inputDigest,
            page,
          });
          assert.ok(result.ok && 'record' in result && result.record.state === 'staging');
          assert.equal(result.record.nextPage, page + 1);
        }
        const reopened = new JsonFileAdapter(file);
        const got = await reopened.persistCatalogDetailApproval('admin', {
          action: 'operation-get',
          productId,
          operationId,
        });
        assert.ok(
          got.ok &&
            'record' in got &&
            got.record.state === 'staging' &&
            got.current &&
            got.revisionCurrent,
        );
        assert.equal(got.record.nextPage, 2);
        keys.add(got.record._id);
        revisions.add(got.record.revision);
        for (const page of [0, 1])
          assert.deepEqual(
            await reopened.persistCatalogDetailApproval('admin', {
              action: 'operation-approval-page',
              productId,
              operationId,
              inputDigest: first.record.operation.inputDigest,
              page,
            }),
            got,
          );
        assert.equal((await reopened.saveCatalogProductWithIdentities(input)).result, 'saved');
      }
    }),
  );
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(keys.size, 20);
  assert.equal(revisions.size, 20);
  assert.equal(stored.catalogDetailApprovals.length, 20);
  assert.equal(stored.catalogDetailVariants.length, 420);
  assert.equal(new Set(stored.catalogDetailVariants.map((v: CollectionDoc) => v._id)).size, 420);
  for (const product of stored.products) {
    assert.equal(product.published, false);
    assert.equal(product.catalogDetailPublication, undefined);
    assert.equal(product.catalogDetailApprovalReceipt, undefined);
    assert.equal(product.productFamily, 'misc');
    assert.deepEqual(product.subcategoryIds, []);
  }
});
