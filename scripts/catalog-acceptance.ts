import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { productPath } from '../apps/site/src/lib/seo/product-identity.ts';
import type {
  CatalogPublicChangeStore,
  CatalogPublicHead,
} from '../packages/db/src/catalog-public-changes.ts';
import {
  CatalogPublicHeadSchema,
  CatalogSeoTaskSchema,
  catalogPublicRecordId,
} from '../packages/db/src/catalog-public-changes.ts';
import type { CatalogSeoStore } from '../packages/db/src/catalog-seo-consumer.ts';
import {
  catalogSeoControlId,
  idleCatalogSeoControl,
  readCatalogSeoControl,
} from '../packages/db/src/catalog-seo-control.ts';
import { createCatalogSeoDelivery } from '../packages/db/src/catalog-seo-delivery.ts';
import { CatalogSeoRecordingConfigSchema } from '../packages/db/src/catalog-seo-requests.ts';
import type { CatalogSeoRecordingConfig } from '../packages/db/src/catalog-seo-requests.ts';
import { sealCatalogBuildInput } from './catalog-build-input.ts';
import { assertCatalogAcceptanceProof } from './release/catalog-proof.mjs';
import { sha256 } from './release/input.mjs';

type Capture = { writes: number; heads: readonly CatalogPublicHead[] };
export type CatalogAcceptanceProof = {
  schemaVersion: 1;
  siteOrigin: string;
  detailEnabled: boolean;
  writes: number;
  headsSha256: string;
  snapshotSha256: string;
};
type AcceptedSiteRun = { state: string; runId: string; accepted?: { sourceRunId: string } | null };

/** Release only an accepted website's interrupted DB registration, retaining all current content and requests. */
export async function clearAcceptedCatalogRegistration({
  store,
  siteOrigin,
  runId,
  acceptedRun,
  checkpoint,
  checkTransaction,
  clock = () => new Date().toISOString(),
}: {
  store: CatalogSeoStore;
  siteOrigin: string;
  runId: string;
  acceptedRun: AcceptedSiteRun;
  checkpoint: () => Promise<unknown>;
  checkTransaction: (tx: CatalogPublicChangeStore) => Promise<unknown>;
  clock?: () => string;
}) {
  assert(
    acceptedRun?.state === 'SUCCEEDED' &&
      acceptedRun.runId === runId &&
      acceptedRun.accepted?.sourceRunId === runId,
    'Only an accepted site may release its DB registration',
  );
  assert(/^site-[1-9][0-9]*-[1-9][0-9]*$/.test(runId), 'Exact accepted site run required');
  const controlId = catalogSeoControlId(siteOrigin);
  const owned = (control: ReturnType<typeof readCatalogSeoControl>) => {
    assert(
      control.state === 'idle' || (control.owner?.startsWith(`${runId}:`) && !control.discovery),
      'Unknown hosting or another catalog owner cannot be cleared',
    );
  };
  await checkpoint();
  const initial = readCatalogSeoControl(
    await store.get('catalogSeoControl', controlId),
    siteOrigin,
    clock(),
  );
  owned(initial);
  for (const productId of initial.products) {
    const row = await store.get('catalogPublicHeads', catalogPublicRecordId(siteOrigin, productId));
    assert(row, 'Unknown catalog control product cannot be cleared');
    const head = CatalogPublicHeadSchema.parse(row);
    assert(
      head.siteOrigin === siteOrigin && head.productId === productId,
      'Unknown catalog control product cannot be cleared',
    );
  }
  let releasedTasks = 0;
  let scanned = 0;
  // Reuse the existing (siteOrigin, state, _id) index; never add a lease-field query dependency.
  for (const state of ['leased', 'writing', 'needs-readback']) {
    let cursor: string | null = null;
    for (;;) {
      const rows = await store.list('catalogSeoTasks', { siteOrigin, state }, cursor, 100);
      scanned += rows.length;
      assert(scanned <= 50_000, 'Catalog cleanup exceeds its bound');
      const tasks = rows
        .map((row) => {
          const task = CatalogSeoTaskSchema.parse(row);
          assert(
            task.siteOrigin === siteOrigin &&
              task.state === state &&
              task._id === catalogPublicRecordId(siteOrigin, task.productId),
            'Wrong catalog cleanup task',
          );
          return task;
        })
        .filter((task) => task.lease?.runId === runId);
      for (let offset = 0; offset < tasks.length; offset += 12) {
        await checkpoint();
        const batch = tasks.slice(offset, offset + 12);
        releasedTasks += await store.transaction(async (tx) => {
          await checkTransaction(tx);
          owned(
            readCatalogSeoControl(
              await tx.get('catalogSeoControl', controlId),
              siteOrigin,
              clock(),
            ),
          );
          const release = [];
          for (const expected of batch) {
            const task = CatalogSeoTaskSchema.parse(await tx.get('catalogSeoTasks', expected._id));
            assert(
              task.siteOrigin === siteOrigin && task.productId === expected.productId,
              'Catalog cleanup task identity changed',
            );
            if (task.lease?.runId === runId)
              release.push(
                CatalogSeoTaskSchema.parse({
                  ...task,
                  state: 'pending',
                  lease: null,
                }),
              );
          }
          for (const task of release) await tx.set('catalogSeoTasks', task);
          return release.length;
        });
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)?._id ?? null;
      assert(cursor, 'Catalog cleanup cursor missing');
    }
  }
  await checkpoint();
  const controlReleased = await store.transaction(async (tx) => {
    await checkTransaction(tx);
    const actual = readCatalogSeoControl(
      await tx.get('catalogSeoControl', controlId),
      siteOrigin,
      clock(),
    );
    owned(actual);
    if (actual.state === 'idle') return false;
    assert(Number.isSafeInteger(actual.fence + 1), 'Catalog fence exceeds bound');
    await tx.set('catalogSeoControl', {
      ...idleCatalogSeoControl(siteOrigin, clock()),
      writes: actual.writes,
      fence: actual.fence + 1,
    });
    return true;
  });
  return { releasedTasks, controlReleased };
}

export function createCatalogAcceptanceProof({
  config,
  capture,
  snapshot,
}: {
  config: CatalogSeoRecordingConfig;
  capture: Capture;
  snapshot: Buffer;
}): CatalogAcceptanceProof {
  const sealed = sealCatalogBuildInput({
    config,
    source: 'accepted',
    snapshot,
    before: capture,
    after: capture,
  });
  const proof: CatalogAcceptanceProof = {
    schemaVersion: 1,
    siteOrigin: config.siteOrigin,
    detailEnabled: config.detailEnabled,
    writes: sealed.writes,
    headsSha256: sealed.headsSha256,
    snapshotSha256: sealed.snapshotSha256,
  };
  assertCatalogAcceptanceProof(proof, { siteOrigin: config.siteOrigin, snapshot });
  return proof;
}

/** Check current content; only an accepted run may repair its own DB-only registration guard. */
export async function prepareCatalogAcceptance({
  store,
  proof,
  snapshot,
  runId,
  acceptedRun = null,
  checkpoint,
  checkTransaction,
  clock = () => new Date().toISOString(),
}: {
  store: CatalogSeoStore;
  proof: CatalogAcceptanceProof;
  snapshot: Buffer;
  runId: string;
  acceptedRun?: null | AcceptedSiteRun;
  checkpoint?: () => Promise<unknown>;
  checkTransaction?: (tx: CatalogPublicChangeStore) => Promise<unknown>;
  clock?: () => string;
}) {
  const config = CatalogSeoRecordingConfigSchema.parse({
    siteOrigin: proof?.siteOrigin,
    detailEnabled: proof?.detailEnabled,
  });
  assertCatalogAcceptanceProof(proof, { siteOrigin: config.siteOrigin, snapshot });
  assert(/^site-[1-9][0-9]*-[1-9][0-9]*$/.test(runId), 'Exact original site run required');
  if (acceptedRun) {
    assert(
      checkpoint && checkTransaction,
      'Accepted registration repair requires its active site guard',
    );
    await clearAcceptedCatalogRegistration({
      store,
      siteOrigin: config.siteOrigin,
      runId,
      acceptedRun,
      checkpoint,
      checkTransaction,
      clock,
    });
  }
  const controlId = catalogSeoControlId(config.siteOrigin);
  const noPending = async () => {
    const pending = await store.list(
      'catalogSeoRequests',
      { siteOrigin: config.siteOrigin, state: 'pending' },
      null,
      1,
    );
    assert.equal(pending.length, 0, 'New product requests exist; rebuild current content');
  };
  const readCurrent = async () => {
    const before = readCatalogSeoControl(
      await store.get('catalogSeoControl', controlId),
      config.siteOrigin,
      clock(),
    );
    await noPending();
    const heads: CatalogPublicHead[] = [];
    let cursor: string | null = null;
    for (;;) {
      const rows = await store.list(
        'catalogPublicHeads',
        { siteOrigin: config.siteOrigin },
        cursor,
        100,
      );
      for (const row of rows) heads.push(CatalogPublicHeadSchema.parse(row));
      if (rows.length < 100) break;
      cursor = rows.at(-1)?._id ?? null;
      assert(cursor && heads.length <= 50_000, 'Catalog version page exceeds bound');
    }
    await noPending();
    const after = readCatalogSeoControl(
      await store.get('catalogSeoControl', controlId),
      config.siteOrigin,
      clock(),
    );
    assert(isDeepStrictEqual(before, after), 'Products changed during acceptance readback');
    assert.deepEqual(
      createCatalogAcceptanceProof({ config, capture: { writes: after.writes, heads }, snapshot }),
      proof,
      'Products changed after delivery; rebuild current content instead of accepting old HTML',
    );
    return { control: after, heads };
  };
  const current = await readCurrent();
  assert.equal(
    current.control.state,
    'idle',
    'Catalog outcome is unknown; read back before further delivery',
  );
  const delivery = createCatalogSeoDelivery(store, config.siteOrigin, proof.writes, runId, clock);
  const checkDelivery = delivery.check;
  delivery.check = async () => {
    await checkDelivery();
    await noPending();
    await checkDelivery();
  };
  return {
    writes: proof.writes,
    heads: current.heads,
    delivery,
  };
}

/** Shared by first publication and readback; it never uploads HTML or changes business content. */
export async function finishCatalogAcceptance({
  catalog,
  files,
  checkpoint = async () => {},
}: {
  catalog: {
    heads: readonly CatalogPublicHead[];
    delivery: ReturnType<typeof createCatalogSeoDelivery>;
  };
  files: ReadonlyMap<string, Buffer>;
  checkpoint?: () => Promise<unknown>;
}) {
  await catalog.delivery.check();
  const pages = catalog.heads.map((head) => {
    const path = `${productPath(head.productId).slice(1)}index.html`;
    const bytes = files.get(path);
    assert(head.visible ? bytes : !bytes, 'Accepted product HTML differs from its public version');
    return { productId: head.productId, htmlSha256: bytes ? sha256(bytes) : null };
  });
  // These exact versions were captured before the accepted site's build. Registration
  // does not upload files, so it must not acquire another artificial hosting ticket.
  catalog.delivery.primeExpectedHeads(catalog.heads);
  for (let offset = 0; offset < pages.length; offset += 12) {
    await checkpoint();
    await catalog.delivery.check();
    await catalog.delivery.accept(pages.slice(offset, offset + 12));
  }
  await catalog.delivery.check();
}
