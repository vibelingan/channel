import { createHash } from 'node:crypto';
import { inventoryIdentity, recoveryStateIdentity } from './hosting-recovery.mjs';
import { checkEntries, freeze, identity, readHostingObject, sha256 } from './release/input.mjs';

/** Keep every file in the accepted identity; omit writes only with exact authenticated object evidence. */
export function selectChangedHostingFiles({ plan, directory, inventory }) {
  const { planSha256, ...body } = plan;
  if (
    planSha256 !== identity(body) ||
    plan.stateSha256 !== recoveryStateIdentity(plan) ||
    plan.retained
  )
    throw new Error('Expected a complete, verified hosting plan.');
  const objects = new Map(
    inventoryIdentity(inventory).map(([path, bytes, etag, lastModified]) => [
      path,
      { path, bytes, etag, lastModified },
    ]),
  );
  const uploads = [];
  const retained = [];
  for (const entry of plan.uploads) {
    const bytes = readHostingObject(directory, entry);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
      throw new Error(`Corrupt hosting artifact: ${entry.path}`);
    const current = objects.get(entry.path);
    const md5 = createHash('md5').update(bytes).digest('hex');
    if (current?.bytes === entry.bytes && current.etag.replaceAll('"', '').toLowerCase() === md5)
      retained.push({
        ...entry,
        proof: { etag: current.etag, lastModified: current.lastModified },
      });
    else uploads.push(entry);
  }
  const next = { ...body, uploads, retained };
  if (recoveryStateIdentity(next) !== plan.stateSha256)
    throw new Error('Incremental selection lost part of the site identity.');
  return freeze({ ...next, planSha256: identity(next) });
}
export function verifyRetainedHostingFiles(retained, inventory) {
  checkEntries(retained);
  const objects = new Map(
    inventoryIdentity(inventory).map(([path, bytes, etag, lastModified]) => [
      path,
      { bytes, etag, lastModified },
    ]),
  );
  for (const entry of retained) {
    const current = objects.get(entry.path);
    if (
      !entry.proof?.etag ||
      !entry.proof.lastModified ||
      current?.bytes !== entry.bytes ||
      current.etag !== entry.proof.etag ||
      current.lastModified !== entry.proof.lastModified
    )
      throw new Error(`Retained hosting object changed: ${entry.path}`);
  }
}
