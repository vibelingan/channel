import { identity, sha256 } from './input.mjs';

const purpose = 'initial-catalog-function-backup';
const names = ['public-api', 'alibaba-catalog-sync', 'admin'];

/** Keep the first working programs across retries, including a reply lost after saving the pointer. */
export async function preserveCatalogRuntimeBackup({
  row,
  objects,
  target,
  codeSha,
  sourceRunId,
  originals,
}) {
  const readRow = async () => {
    const response = await row.get();
    const value = Array.isArray(response.data) ? response.data[0] : response.data;
    if (!value) return null;
    const { _id, ...record } = value;
    return record;
  };
  const check = async (record) => {
    if (
      record.schemaVersion !== 1 ||
      record.purpose !== purpose ||
      record.codeSha !== codeSha ||
      record.siteOrigin !== target.siteOrigin
    )
      throw Error('An existing initial function backup differs');
    const manifest = JSON.parse((await objects.get(record.manifestObject)).toString());
    if (
      manifest.purpose !== purpose ||
      identity(manifest.target) !== identity(target) ||
      !Array.isArray(manifest.originals) ||
      identity(manifest.originals.map((x) => x.name)) !== identity(names)
    )
      throw Error('Original function backup manifest differs');
    for (const entry of manifest.originals) {
      if (
        entry.snapshot?.name !== entry.name ||
        entry.snapshot.status !== 'Active' ||
        entry.snapshot.availableStatus !== 'Available' ||
        entry.snapshot.packageSha256 !== entry.object?.sha256 ||
        entry.snapshot.packageBytes !== entry.object?.bytes ||
        !/^[a-f0-9]{40}$/.test(manifest.versions?.[entry.name] ?? '')
      )
        throw Error('Original function package identity differs');
      await objects.get(entry.object);
    }
    return record;
  };
  const existing = await readRow();
  if (existing) return check(existing);
  if (identity(originals.map((x) => x.name)) !== identity(names))
    throw Error('All three original programs are required');
  const entries = [];
  const versions = {};
  for (const { name, snapshot, bytes, version } of originals) {
    if (
      !Buffer.isBuffer(bytes) ||
      sha256(bytes) !== snapshot.packageSha256 ||
      bytes.length !== snapshot.packageBytes ||
      !/^[a-f0-9]{40}$/.test(version)
    )
      throw Error('Original function bytes differ before retention');
    versions[name] = version;
    entries.push({ name, snapshot, object: await objects.put(bytes) });
  }
  const manifestObject = await objects.put(
    Buffer.from(JSON.stringify({ purpose, target, versions, originals: entries })),
  );
  const record = {
    schemaVersion: 1,
    purpose,
    codeSha,
    siteOrigin: target.siteOrigin,
    sourceRunId,
    manifestObject,
  };
  await check(record);
  try {
    await row.set(record);
  } catch {
    /* A complete read below settles a lost reply. */
  }
  const saved = await readRow();
  if (!saved || identity(saved) !== identity(record))
    throw Error('Original function retention needs readback');
  return saved;
}
