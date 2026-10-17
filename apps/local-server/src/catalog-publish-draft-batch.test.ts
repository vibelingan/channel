import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CatalogProductSaveInput } from '@vibelingan-channel/db/adapter';
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
