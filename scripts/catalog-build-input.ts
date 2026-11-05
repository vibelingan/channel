import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  type CatalogPublicHead,
  CatalogPublicHeadSchema,
  catalogPublicRecordId,
} from '../packages/db/src/catalog-public-changes.ts';
import {
  type CatalogSeoRecordingConfig,
  CatalogSeoRecordingConfigSchema,
} from '../packages/db/src/catalog-seo-requests.ts';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Capture = { writes: number; heads: readonly CatalogPublicHead[] };
type Options = {
  config: CatalogSeoRecordingConfig;
  source: 'fresh' | 'accepted';
  snapshot: Uint8Array;
};

export function assertPrebuiltCatalogMode(env: Record<string, string | undefined>) {
  if (env.SITE_DELIVERY_BUILT_INPUT !== '1') return;
  assert(
    env.SITE_DELIVERY_MODE === 'publish' &&
      env.SITE_CATALOG_BOOTSTRAP !== '1' &&
      (env.SITE_PRODUCT_SOURCE === 'fresh' || env.SITE_PRODUCT_SOURCE === 'accepted'),
    'Prebuilt HTML cannot be combined with refresh, bootstrap or restoration',
  );
}

/** Bind versions during capture, before Astro builds HTML, never during publication. */
export function versionFreshCatalogBuildSnapshot(
  options: Options & { before: Capture; after: Capture },
) {
  sealCatalogBuildInput(options); // Prove the whole capture interval first.
  assert.equal(options.source, 'fresh');
  const decoded = record(JSON.parse(Buffer.from(options.snapshot).toString('utf8')));
  assert(decoded.purpose === 'public' && decoded.siteOrigin === options.config.siteOrigin);
  assert(Array.isArray(decoded.products), 'Invalid public snapshot');
  const heads = new Map(options.after.heads.filter((h) => h.visible).map((h) => [h.productId, h]));
  assert.equal(
    decoded.products.length,
    heads.size,
    'Captured product inventory differs from current versions',
  );
  const products = decoded.products.map((value) => {
    const entry = record(value);
    const product = record(entry.product);
    assert(typeof product._id === 'string');
    const h = heads.get(product._id);
    assert(
      h && (entry.detail === undefined ? null : record(entry.detail).revision) === h.detailRevision,
      'Captured detail differs from the current product version',
    );
    heads.delete(product._id);
    return {
      ...entry,
      publicVersion: { sequence: h.sequence, semanticHash: h.semanticHash, changedAt: h.changedAt },
    };
  });
  return Buffer.from(JSON.stringify({ ...decoded, products }));
}
function version(config: CatalogSeoRecordingConfig, capture: Capture) {
  CatalogSeoRecordingConfigSchema.parse(config);
  assert(
    Number.isSafeInteger(capture.writes) && capture.writes >= 0,
    'Invalid product write version',
  );
  const seen = new Set<string>();
  const heads = capture.heads
    .map((input) => {
      const h = CatalogPublicHeadSchema.parse(input);
      assert(
        h.siteOrigin === config.siteOrigin &&
          h._id === catalogPublicRecordId(config.siteOrigin, h.productId),
        'Wrong product version identity',
      );
      assert(!seen.has(h.productId), 'Duplicate product version');
      seen.add(h.productId);
      return {
        productId: h.productId,
        visible: h.visible,
        sequence: h.sequence,
        semanticHash: h.semanticHash,
        detailRevision: h.detailRevision,
        changedAt: h.changedAt,
      };
    })
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  return { writes: capture.writes, headsSha256: digest(JSON.stringify(heads)) };
}
/** Only a snapshot collected between two identical, settled catalog reads can attest a build. */
export function sealCatalogBuildInput(options: Options & { before: Capture; after: Capture }) {
  const { config, source, snapshot, before, after } = options;
  assert.deepEqual(
    version(config, before),
    version(config, after),
    'Products changed while collecting the build input; retry from current data',
  );
  assert(source === 'fresh' || source === 'accepted', 'Explicit product source required');
  if (source === 'accepted') {
    const current = new Map(after.heads.filter((h) => h.visible).map((h) => [h.productId, h]));
    const decoded = record(JSON.parse(Buffer.from(snapshot).toString('utf8')));
    assert(decoded.purpose === 'public' && decoded.siteOrigin === config.siteOrigin);
    assert(Array.isArray(decoded.products), 'Invalid accepted product snapshot');
    assert.equal(decoded.products.length, current.size, 'Accepted product inventory is stale');
    const seen = new Set();
    for (const value of decoded.products) {
      const entry = record(value);
      const product = record(entry.product);
      assert(
        typeof product._id === 'string' && !seen.has(product._id),
        'Invalid accepted product identity',
      );
      seen.add(product._id);
      const head = current.get(product._id);
      const publicVersion = record(entry.publicVersion);
      const revision = entry.detail === undefined ? null : record(entry.detail).revision;
      assert(
        head &&
          publicVersion.sequence === head.sequence &&
          publicVersion.semanticHash === head.semanticHash &&
          publicVersion.changedAt === head.changedAt &&
          revision === head.detailRevision,
        'Accepted product snapshot lacks the current public version; use fresh or refresh',
      );
    }
  }
  return {
    schemaVersion: 1,
    tracked: true,
    ...config,
    source,
    ...version(config, after),
    snapshotSha256: digest(snapshot),
  };
}

/** Compare the original capture proof, never re-label old HTML with today's version. */
export function assertCatalogBuildInputCurrent(
  options: Options & { proof: unknown; current: Capture },
) {
  const { config, source, snapshot, current } = options;
  assert(source === 'fresh' || source === 'accepted', 'Explicit product source required');
  assert.deepEqual(
    options.proof,
    {
      schemaVersion: 1,
      tracked: true,
      ...config,
      source,
      ...version(config, current),
      snapshotSha256: digest(snapshot),
    },
    'Products changed after the site build; no website upload started. Rebuild from current data.',
  );
}

function record(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Missing accepted product version; use fresh or refresh',
  );
  return value as Record<string, unknown>;
}
