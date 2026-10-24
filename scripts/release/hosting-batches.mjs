import { checkEntries, freeze, identity, isHash } from './input.mjs';
export function hostingFilePhase(entry, output) {
  const discovery =
    /(?:^|\/)sitemap(?:-[A-Za-z0-9_-]+)?\.xml$/.test(entry.path) ||
    ['robots.txt', 'seo-manifest.json', 'products/manifest.json'].includes(entry.path) ||
    output.discoveryPaths?.includes(entry.path);
  return discovery
    ? 3
    : /^(?:products\/p-[A-Za-z0-9_-]+|blog\/[a-z0-9-]+)\/index\.html$/.test(entry.path) &&
        entry.path !== 'blog/index.html'
      ? 1
      : entry.path.endsWith('.html')
        ? 2
        : 0;
}
export const hostingBatchHash = (entries) =>
  identity(entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
export const hostingBatchBeforeHash = (members) =>
  identity(members.map(({ path, beforeHash }) => ({ path, beforeHash })));
export function assertHostingBatchMembers(members) {
  if (!Array.isArray(members) || members.length > 12 || !members.length)
    throw Error('Invalid hosting batch size');
  checkEntries(members);
  if (members.some((e) => !isHash(e.beforeHash) && e.beforeHash !== 'absent'))
    throw Error('Invalid hosting batch before state');
}
export function siteUploadBatches(plan) {
  if (!plan.delivery) return null;
  if (plan.scope.kind !== 'site' || plan.delivery.batchSize !== 12 || plan.delivery.parallel !== 4)
    throw Error('Unreviewed hosting batch settings');
  const batches = [];
  for (const entry of plan.uploads) {
    const last = batches.at(-1);
    if (
      !last ||
      last.length === 12 ||
      hostingFilePhase(last[0], plan.publicOutput) !== hostingFilePhase(entry, plan.publicOutput)
    )
      batches.push([entry]);
    else last.push(entry);
  }
  return freeze(batches);
}
export function withSiteUploadBatches(plan) {
  const { planSha256, ...body } = plan;
  if (identity(body) !== planSha256 || plan.delivery || plan.scope.kind !== 'site')
    throw Error('Invalid unbatched site plan');
  const next = { ...body, delivery: { batchSize: 12, parallel: 4 } };
  return freeze({ ...next, planSha256: identity(next) });
}
/** Stop scheduling after failure; wait for all already started work before rejecting. */
export async function mapHostingBounded(items, parallel, callback) {
  if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 4)
    throw Error('Invalid hosting parallel limit');
  const results = new Array(items.length);
  let next = 0;
  let failure;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(parallel, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await callback(items[index], index);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}
