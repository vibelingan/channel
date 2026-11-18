/** Temporary authenticated acceptance entry. Never imported by a business handler. */
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import {
  get,
  list,
  manageSourceMediaImport,
  removeDocIfFieldEquals,
  setAdapter,
} from '@vibelingan-channel/db';
import { readCatalogWebImage } from '@vibelingan-channel/db/catalog-web-image';
import { cloudBaseAdapter, cloudStorageSdk, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import { mediaStorage, setMediaStorage } from '@vibelingan-channel/media-storage';
import { createCloudBaseMediaStorage } from '@vibelingan-channel/media-storage/cloudbase';
import { decodeCatalogImagePixels } from '@vibelingan-channel/media-storage/pixels';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { sourceProbePng } from '../../../../../packages/media-storage/src/source-probe-fixture.test-helper.ts';
import { cleanupSourceMediaImage } from '../../../admin/src/source-media-cleanup.ts';
import {
  ALIBABA_IMAGE_IMPORT_OWNER,
  importCandidateImage,
  removeImportedCandidate,
} from '../media-import.ts';

const environment = 'diversity-123-d9grnqfux221323bb';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function authorizeSourceMediaProbe(event: unknown, env: NodeJS.ProcessEnv) {
  assert.equal(env.TCB_ENV, environment, 'Wrong source probe environment');
  const run = env.SOURCE_MEDIA_PROBE_RUN ?? '';
  const sourceSha = env.SOURCE_MEDIA_PROBE_SHA ?? '';
  assert.match(run, /^[a-f0-9]{32}$/, 'Exact isolated source identity required');
  assert.match(sourceSha, /^[a-f0-9]{40}$/, 'Exact source commit required');
  assert.ok(event && typeof event === 'object' && !Array.isArray(event), 'Invalid probe event');
  const action = Reflect.get(event, 'action');
  assert.ok(['run', 'status', 'cleanup'].includes(action), 'Unplanned probe action');
  const token = Reflect.get(event, 'token');
  const digest = env.SOURCE_MEDIA_PROBE_DIGEST ?? '';
  assert.ok(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'Invalid probe token');
  assert.match(digest, /^[a-f0-9]{64}$/, 'Missing probe credential');
  assert.ok(
    timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(sha256(token), 'hex')),
    'Probe authentication failed',
  );
  const expires = Date.parse(env.SOURCE_MEDIA_PROBE_EXPIRES ?? '');
  assert.ok(Number.isFinite(expires), 'Missing probe expiry');
  if (action === 'run') assert.ok(Date.now() < expires, 'Probe write window expired');
  return {
    action: action as 'run' | 'status' | 'cleanup',
    run,
    sourceSha,
    sourceUrl: `https://sc04.alicdn.com/channel-seo-acceptance/${run}.png`,
  };
}

export function assertSourceProbeImage(image: CollectionDoc, sourceUrl: string) {
  assert.match(image._id, uuid, 'Unexpected source image identity');
  assert.equal(image.uploadedByUserId, ALIBABA_IMAGE_IMPORT_OWNER, 'Foreign image owner');
  assert.equal(image.publishedRefCount, 0, 'Image acquired a public reference');
  const ownership = image.sourceMediaImport;
  assert.ok(ownership && typeof ownership === 'object', 'Missing source ownership');
  assert.equal(Reflect.get(ownership, 'sourceUrl'), sourceUrl, 'Foreign source image');
  assert.equal(Reflect.get(ownership, 'imageId'), image._id, 'Foreign image claim');
}

export async function main(event: unknown) {
  // Authentication and scope checks precede SDK initialization and every cloud access.
  const scope = authorizeSourceMediaProbe(event, process.env);
  initCloudBase(environment);
  setAdapter(cloudBaseAdapter);
  setMediaStorage(createCloudBaseMediaStorage(cloudStorageSdk()));
  const linkId = sourceMediaLinkId('alibaba', scope.sourceUrl);
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    action: scope.action,
    run: scope.run,
    sourceSha: scope.sourceSha,
    sourceUrl: scope.sourceUrl,
    linkId,
    sourceFetch: 'synthetic-response-only',
    actualCloudDatabase: true,
    actualCloudStorage: true,
    productsWritten: 0,
  };
  const bound = async () => {
    const link = await get('catalogSourceLinks', linkId);
    if (link) {
      assert.equal(link.sourceUrl, scope.sourceUrl, 'Foreign source link');
      assert.equal(link.kind, 'media');
      assert.equal(link.provider, 'alibaba');
    }
    const claim = link?.mediaImport;
    const id =
      typeof link?.imageId === 'string'
        ? link.imageId
        : claim && typeof claim === 'object'
          ? Reflect.get(claim, 'imageId')
          : undefined;
    if (id === undefined) return { link, image: null };
    assert.ok(typeof id === 'string' && uuid.test(id), 'Unexpected link image identity');
    const image = await get('images', id);
    if (image) assertSourceProbeImage(image, scope.sourceUrl);
    return { link, image };
  };
  if (scope.action === 'status') return { ...receipt, ...(await bound()) };
  if (scope.action === 'cleanup') {
    const { link, image } = await bound();
    if (image) {
      receipt.imageId = image._id;
      receipt.objects = [image, readCatalogWebImage(image)].filter(Boolean).map((row) => ({
        storageFileId: row?.storageFileId,
        storagePath: row?.storagePath,
      }));
      const result =
        image.status === 'active' || image.status === 'deleted'
          ? await removeImportedCandidate(image._id)
          : await cleanupSourceMediaImage(image._id);
      receipt.cleanup = result;
      assert.equal(await get('images', image._id), null, 'Owned image cleanup not confirmed');
    }
    if (link) {
      // The synthetic source name is immutable and never submitted to a product.
      // Verify this same link again; never remove a customer-supplied identifier.
      const current = await get('catalogSourceLinks', linkId);
      assert.deepEqual(current, link, 'Source link changed before cleanup');
      assert.ok(
        await removeDocIfFieldEquals('catalogSourceLinks', linkId, 'sourceUrl', scope.sourceUrl),
        'Source link removal not acknowledged',
      );
    }
    assert.equal(await get('catalogSourceLinks', linkId), null);
    return { ...receipt, cleaned: true };
  }
  assert.equal(
    await get('catalogSourceLinks', linkId),
    null,
    'Probe already started; inspect status instead of rerunning',
  );
  const bytes = await sourceProbePng(scope.run);
  assert.ok(bytes.length > 4_500_000 && bytes.length < 5_000_000);
  const checksum = sha256(bytes);
  const existing = await list({
    collection: 'images',
    page: 1,
    pageSize: 1,
    filter: {
      combinator: 'and',
      clauses: [{ field: 'checksumSha256', op: 'eq', value: checksum }],
    },
  });
  assert.equal(existing.items.length, 0, 'Fixture checksum already belongs to an existing image');
  receipt.originalBytes = bytes.length;
  receipt.originalSha256 = checksum;
  let ownerImageId: string | undefined;
  const proposedIds: string[] = [];
  let fetches = 0;
  const started = Date.now();
  try {
    const deps = {
      // Only the external supplier response is substituted. URL and real DNS checks,
      // native SDK identity, transactions, conversion and object transfer remain real.
      fetchImpl: (async (input: string | URL | Request) => {
        assert.equal(String(input), scope.sourceUrl, 'Unexpected supplier URL');
        fetches++;
        return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }) as typeof fetch,
      persistImport: async (command: Parameters<typeof manageSourceMediaImport>[0]) => {
        assert.ok(command.action !== 'reuse', 'Refusing to reuse a customer image');
        assert.ok(command.action !== 'retire', 'Unexpected import retirement');
        assert.ok(command.action !== 'note-failure', 'Unexpected source failure note');
        assert.equal(command.sourceUrl, scope.sourceUrl);
        if (command.action === 'claim') {
          proposedIds.push(command.imageId);
          ownerImageId ??= command.imageId;
        } else assert.equal(command.imageId, ownerImageId, 'Foreign image mutation');
        const result = await manageSourceMediaImport(command);
        if ('imageId' in result)
          assert.equal(result.imageId, ownerImageId, 'Foreign image returned');
        return result;
      },
    };
    const first = await importCandidateImage(scope.sourceUrl, deps);
    assert.ok(first.ok, `Source import failed: ${first.ok ? '' : first.reason}`);
    assert.equal(first.imageId, ownerImageId);
    const image = await get('images', first.imageId);
    assert.ok(image);
    assertSourceProbeImage(image, scope.sourceUrl);
    assert.equal(image.status, 'active');
    assert.equal(image.byteSize, bytes.length);
    assert.equal(image.checksumSha256, checksum);
    const web = readCatalogWebImage(image);
    assert.ok(web, 'Active source image has no safe web version');
    const read = async (id: string, maximum: number) =>
      Buffer.from(
        (await mediaStorage().getObjectAsBase64(id, { maxBytes: maximum, timeoutMs: 30_000 })).body,
        'base64',
      );
    const original = await read(String(image.storageFileId), 5_000_000);
    assert.equal(sha256(original), checksum);
    const small = await read(web.storageFileId, 3_000_000);
    assert.equal(sha256(small), web.checksumSha256);
    assert.equal(small.length, web.byteSize);
    const pixels = await decodeCatalogImagePixels(small, web.mimeType);
    assert.equal(pixels.status, 'decoded');
    if (pixels.status === 'decoded') {
      assert.equal(pixels.width, web.width);
      assert.equal(pixels.height, web.height);
    }
    const second = await importCandidateImage(scope.sourceUrl, deps);
    assert.ok(second.ok);
    assert.equal(second.imageId, first.imageId);
    assert.equal(second.deduplicated, true);
    assert.equal(fetches, 1, 'Same source replay fetched again');
    assert.deepEqual(await get('images', first.imageId), image, 'Replay changed the image');
    for (const id of proposedIds.slice(1))
      assert.equal(await get('images', id), null, 'Replay created another image');
    Object.assign(receipt, {
      passed: true,
      imageId: first.imageId,
      supplierFetches: fetches,
      replaySameImage: true,
      proposedImageIds: proposedIds,
      webBytes: web.byteSize,
      webWidth: web.width,
      webHeight: web.height,
      webSha256: web.checksumSha256,
      objects: [image, web].map((row) => ({
        storageFileId: row.storageFileId,
        storagePath: row.storagePath,
      })),
    });
  } catch (error) {
    receipt.passed = false;
    receipt.imageId = ownerImageId;
    receipt.failure =
      error instanceof assert.AssertionError
        ? error.message.slice(0, 300)
        : 'Source acceptance failed; inspect private function diagnostics';
  }
  return { ...receipt, elapsedMs: Date.now() - started };
}
