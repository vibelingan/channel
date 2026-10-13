import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  primarySourceLinkSnapshot,
  sourceBindingSnapshot,
} from '@vibelingan-channel/db/catalog-source-binding';
import {
  SourcePageSchema,
  sourceDigest,
  sourceGalleryDigest,
} from '@vibelingan-channel/db/catalog-source-staging';
import { sourceObservationFixture } from '../../functions/alibaba-catalog-sync/src/testing/source-observation-fixture.ts';
import { JsonFileAdapter } from './json-adapter.ts';

for (const sourceFirst of [false, true])
  test(`two actual JSON adapters keep unlink effective against preparation (sourceFirst=${sourceFirst})`, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-source-binding-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'db.json');
    const now = '2026-01-01T00:00:00.000Z';
    const source = {
      _id: 'k',
      sourceKey: 'k',
      connectionId: 'fixture',
      sourceProductId: 'external',
      sourceTitle: 'Clock',
      active: true,
    };
    const link = {
      _id: 'k',
      sourceKey: 'k',
      connectionId: source.connectionId,
      sourceProductId: source.sourceProductId,
      productId: 'p',
      linkedAt: now,
    };
    const observation = sourceObservationFixture(source);
    const product = {
      _id: 'p',
      name: 'Clock',
      productFamily: 'misc',
      published: false,
      archived: false,
      imageIds: [],
      alibabaPrimarySourceKey: 'k',
      catalogContentGeneration: 4,
      detailSourceReady: false,
    };
    writeFileSync(
      file,
      JSON.stringify({
        products: [product],
        alibabaSourceProducts: [source],
        alibabaProductLinks: [link],
        catalogSourceObservations: [observation],
        users: [{ _id: 'admin', role: 'admin' }],
      }),
    );
    const preparation = new JsonFileAdapter(file);
    const editor = new JsonFileAdapter(file);
    const snapshot = sourceBindingSnapshot(source, observation);
    const primary = primarySourceLinkSnapshot(source, link, 'p');
    assert.ok(snapshot.ok && primary.ok);
    const packet = SourcePageSchema.parse({
      action: 'source-page',
      productId: 'p',
      sourceKey: 'k',
      observationId: observation._id,
      observationDigest: sourceDigest(observation.observation),
      expectedBinding: { ...snapshot.expectation, linkHash: primary.linkHash },
      galleryDigest: sourceGalleryDigest(product),
      contentGeneration: 4,
      revision: 'a'.repeat(64),
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'p',
        name: 'Clock',
        images: [],
        facts: [],
        offers: [],
      },
      content: null,
      noteBlocks: null,
      variantIds: [],
      page: 0,
      variants: [],
    });
    const prepare = () => preparation.persistCatalogDetailApproval('admin', packet);
    const unlink = () =>
      editor.mutateAlibabaProduct({
        action: 'unlink',
        productId: 'p',
        expectedRevision: 0,
        expectedPrimarySourceKey: 'k',
        expectedLinks: [link],
        now,
      });
    const results = await Promise.all(sourceFirst ? [prepare(), unlink()] : [unlink(), prepare()]);
    const prepared = results[sourceFirst ? 0 : 1];
    const unlinked = results[sourceFirst ? 1 : 0];
    assert.equal(prepared?.ok, sourceFirst);
    assert.equal(unlinked?.ok, true);
    const saved = await editor.get('products', 'p');
    assert.equal(saved?.alibabaPrimarySourceKey, null);
    assert.equal(saved?.catalogContentGeneration, 5);
    assert.equal(saved?.detailSourceReady, false);
    assert.equal(saved?.published, false);
    assert.equal(saved?.productFamily, 'misc');
    assert.equal(await editor.get('alibabaProductLinks', 'k'), null);
    const late = await preparation.persistCatalogDetailApproval('admin', packet);
    assert.deepEqual(late, { ok: false, code: 'CONFLICT' });
    assert.deepEqual(await preparation.get('products', 'p'), saved);
  });
