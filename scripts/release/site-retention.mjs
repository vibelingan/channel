import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { identity, sha256 } from './input.mjs';
import { SITE_PACK_LAYOUT, checkSitePackLayout, planSitePacks } from './site-packs.mjs';
const proofs = new WeakSet();
const script = (name) => new URL(`./${name}`, import.meta.url).pathname;
const isHash = (value) => /^[a-f0-9]{64}$/.test(value ?? '');

/** Proofs are issued only by the archive reader after authenticated lookup and byte verification. */
export function retainedSiteProof(proof, envelope) {
  return Boolean(
    proof &&
      proofs.has(proof) &&
      proof.artifactId === envelope.artifact?.artifactId &&
      proof.manifestSha256 === envelope.artifact?.manifestSha256 &&
      proof.releaseId === envelope.releaseId &&
      proof.codeSha === envelope.codeSha &&
      identity(proof.target) === identity(envelope.target),
  );
}

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < items.length && !failure) {
      const index = next++;
      try {
        results[index] = await operation(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return results;
}

// Uploads share one link (~350–580 KB/s from the US, reached with 8 connections) and
// COS sends an object of n MiB as n parallel 1 MiB parts, each with its own deadline
// (60 s up to 8 MiB). Keeping about 8 parts in flight gives the whole link without
// starving any part: a multipart video goes alone, small packs go 8 at a time.
export const UPLOAD_PART_BUDGET = 8;
export const uploadParts = (bytes) =>
  Math.min(UPLOAD_PART_BUDGET, Math.max(1, Math.ceil(bytes / (1024 * 1024))));
export async function mapByParts(items, partsOf, operation) {
  const queue = items.map((item, index) => ({ item, index, parts: partsOf(item) }));
  const running = new Set();
  let used = 0;
  let failure = null;
  while (queue.length && !failure) {
    while (
      queue.length &&
      !failure &&
      (used + queue[0].parts <= UPLOAD_PART_BUDGET || !running.size)
    ) {
      const next = queue.shift();
      used += next.parts;
      const task = operation(next.item, next.index)
        .catch((error) => {
          failure ??= error;
        })
        .finally(() => {
          used -= next.parts;
          running.delete(task);
        });
      running.add(task);
    }
    if (running.size) await Promise.race(running);
  }
  await Promise.all(running);
  if (failure) throw failure;
}

/**
 * Schema 1 records (doc id = artifact id) hold one ZIP of the whole payload and stay
 * readable. Schema 2 records (doc id `site-v2-<artifact id>`, so code without schema 2
 * support finds no record and falls back to the GitHub artifact) list objects planned by
 * site-packs.mjs. Objects are shared between records: never delete one without counting
 * references across every record.
 */
export function createSiteRetention({
  db,
  objects,
  policy,
  layout = SITE_PACK_LAYOUT,
  parallel = 8,
  onEvent = (_event) => {},
}) {
  const plannedLayout = checkSitePackLayout(layout);
  // Objects this process has proven: content id → { object, etag } as last verified.
  const known = new Map();
  const at = async (id) => {
    const response = await db.collection('catalogSeoArchives').doc(id).get();
    if (!response || !Object.hasOwn(response, 'data'))
      throw Error('Retained artifact lookup failed');
    return Array.isArray(response.data) ? response.data[0] : response.data;
  };
  const exact = (id) => {
    if (!/^[1-9][0-9]*$/.test(id)) throw Error('Exact retained artifact ID required');
    return id;
  };
  const row = (id) => at(exact(id));
  const rowV2 = (id) => at(`site-v2-${exact(id)}`);
  const remember = (record) => {
    if (record?.schemaVersion !== 2) return;
    for (const item of record.objects)
      known.set(item.contentSha256, { object: item.object, etag: item.etag });
  };
  const sameSource = (record, schemaVersion) =>
    record?.schemaVersion === schemaVersion &&
    record.target?.envId === policy.envId &&
    record.target.siteOrigin === policy.siteOrigin &&
    record.repository === policy.repository &&
    isHash(record.manifestSha256);
  const proven = (record, directory) => {
    const manifestBytes = readFileSync(join(directory, 'payload-manifest.json'));
    const payload = JSON.parse(manifestBytes);
    if (
      sha256(manifestBytes) !== record.manifestSha256 ||
      payload.releaseId !== record.releaseId ||
      payload.codeSha !== record.codeSha ||
      identity(payload.target) !== identity(record.target) ||
      payload.scope?.kind !== 'site'
    )
      throw Error('Retained payload identity differs');
    const proof = Object.freeze({
      artifactId: record.artifactId,
      manifestSha256: record.manifestSha256,
      releaseId: record.releaseId,
      codeSha: record.codeSha,
      target: Object.freeze({ ...record.target }),
    });
    proofs.add(proof);
    return {
      ...record.run,
      artifact: {
        ...record.run.artifact,
        expired: Date.parse(record.run.artifact.expiresAt) <= Date.now(),
      },
      retainedProof: proof,
    };
  };
  const loadV1 = async (record, directory) => {
    if (!sameSource(record, 1) || record.archiveObject?.sha256 !== record.archiveSha256)
      throw Error('Retained artifact record differs');
    const archive = await objects.get(record.archiveObject);
    if (archive.length !== record.bytes || sha256(archive) !== record.archiveSha256)
      throw Error('Retained release ZIP differs');
    const file = `${directory}.retained.zip`;
    writeFileSync(file, archive, { flag: 'wx', mode: 0o600 });
    execFileSync('python3', [script('extract-site-payload.py'), file, directory], {
      stdio: 'pipe',
    });
    return proven(record, directory);
  };
  const loadV2 = async (record, directory) => {
    const keys = new Set();
    if (
      !sameSource(record, 2) ||
      !Array.isArray(record.objects) ||
      !record.objects.length ||
      record.objects.length > 4096 ||
      record.objects.some(
        (item) =>
          typeof item?.key !== 'string' ||
          keys.size === keys.add(item.key).size ||
          !isHash(item.contentSha256) ||
          !isHash(item.object?.sha256) ||
          !Number.isSafeInteger(item.object.bytes) ||
          typeof item.object.fileID !== 'string',
      )
    )
      throw Error('Retained artifact record differs');
    const recordedLayout = checkSitePackLayout(record.layout);
    const work = `${directory}.objects`;
    mkdirSync(work, { recursive: false, mode: 0o700 });
    try {
      const files = await mapLimit(record.objects, parallel, async (item, index) => {
        const bytes = await objects.get(item.object);
        if (bytes.length !== item.object.bytes || sha256(bytes) !== item.object.sha256)
          throw Error('Retained release ZIP differs');
        const file = join(work, `${index}.zip`);
        writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
        return file;
      });
      const head = files[record.objects.findIndex((item) => item.key === 'head')];
      if (!head) throw Error('Retained artifact record differs');
      const manifestBytes = execFileSync(
        'python3',
        [script('extract-site-objects.py'), 'read', head, 'payload-manifest.json'],
        { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
      );
      if (sha256(manifestBytes) !== record.manifestSha256)
        throw Error('Retained payload identity differs');
      const plan = planSitePacks({
        entries: JSON.parse(manifestBytes).entries,
        manifest: { bytes: manifestBytes.length, sha256: record.manifestSha256 },
        layout: recordedLayout,
      });
      const byKey = new Map(record.objects.map((item, index) => [item.key, index]));
      if (
        plan.length !== record.objects.length ||
        plan.some(
          (item) => record.objects[byKey.get(item.key)]?.contentSha256 !== item.contentSha256,
        )
      )
        throw Error('Retained archive plan differs');
      const planFile = join(work, 'plan.json');
      writeFileSync(
        planFile,
        JSON.stringify(
          plan.map((item) => ({ zip: files[byKey.get(item.key)], members: item.members })),
        ),
        { flag: 'wx', mode: 0o600 },
      );
      execFileSync('python3', [script('extract-site-objects.py'), 'extract', planFile, directory], {
        stdio: 'pipe',
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    const result = proven(record, directory);
    remember(record);
    return result;
  };
  // Reuse only an object whose current version is the one proven earlier; anything else
  // (absent, resized, rewritten and unreadable) is uploaded again from this payload.
  const reuse = async (item) => {
    const prior = known.get(item.contentSha256);
    if (!prior) return null;
    try {
      const current = await objects.stat(prior.object);
      if (current.bytes !== prior.object.bytes) return null;
      if (current.etag === prior.etag)
        return { object: prior.object, etag: prior.etag, via: 'etag' };
      await objects.get(prior.object);
      return { object: prior.object, etag: current.etag, via: 'read' };
    } catch (error) {
      onEvent({ action: 'reuse-refused', key: item.key, cause: error?.code ?? 'unverified' });
      return null;
    }
  };
  return {
    async download(id, directory) {
      const record = await rowV2(String(id));
      if (record) return loadV2(record, directory);
      const previous = await row(String(id));
      return previous ? loadV1(previous, directory) : null;
    },
    async save(input) {
      const { envelope: e, run, directory } = input;
      if (
        e.scope?.kind !== 'site' ||
        e.functions?.length ||
        e.target.envId !== policy.envId ||
        e.target.siteOrigin !== policy.siteOrigin ||
        run.repository !== policy.repository ||
        run.headSha !== e.codeSha ||
        run.artifact.id !== e.artifact.artifactId
      )
        throw Error('Only a verified public website payload can be retained');
      const id = e.artifact.artifactId;
      const existing = (await rowV2(id)) ?? (await row(id));
      if (existing) {
        if (existing.manifestSha256 !== e.artifact.manifestSha256)
          throw Error('Retained artifact cannot be replaced');
        remember(existing);
        return;
      }
      if (typeof objects.stat !== 'function')
        throw Error('Archive object version check unavailable');
      const started = Date.now();
      const manifestBytes = readFileSync(join(directory, 'payload-manifest.json'));
      if (sha256(manifestBytes) !== e.artifact.manifestSha256)
        throw Error('Retained payload manifest differs');
      const plan = planSitePacks({
        entries: JSON.parse(manifestBytes).entries,
        manifest: { bytes: manifestBytes.length, sha256: e.artifact.manifestSha256 },
        layout: plannedLayout,
      });
      const stored = await mapLimit(plan, parallel, reuse);
      const fresh = plan.flatMap((item, index) => (stored[index] ? [] : [{ item, index }]));
      if (fresh.length) {
        const work = join(dirname(directory), `${id}-retention-objects`);
        mkdirSync(work, { recursive: false, mode: 0o700 });
        try {
          const zips = fresh.map((_, n) => join(work, `${n}.zip`));
          const packPlan = join(work, 'pack.json');
          const checkPlan = join(work, 'check.json');
          writeFileSync(
            packPlan,
            JSON.stringify(
              fresh.map(({ item }, n) => ({
                output: zips[n],
                members: item.members.map((m) => m[0]),
              })),
            ),
            { flag: 'wx', mode: 0o600 },
          );
          writeFileSync(
            checkPlan,
            JSON.stringify(fresh.map(({ item }, n) => ({ zip: zips[n], members: item.members }))),
            { flag: 'wx', mode: 0o600 },
          );
          execFileSync('python3', [script('pack-site-objects.py'), directory, packPlan], {
            stdio: 'pipe',
          });
          // The packed ZIPs must hold exactly the planned bytes before any upload.
          execFileSync('python3', [script('extract-site-objects.py'), 'check', checkPlan], {
            stdio: 'pipe',
          });
          const sizes = zips.map((zip) => statSync(zip).size);
          await mapByParts(
            fresh.map((value, n) => ({ ...value, n })),
            ({ n }) => uploadParts(sizes[n]),
            async ({ index, n }) => {
              const object = await objects.put(readFileSync(zips[n]));
              const version = await objects.stat(object);
              if (version.bytes !== object.bytes) throw Error('Retained object size differs');
              stored[index] = { object, etag: version.etag, via: 'upload' };
            },
          );
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      }
      const record = {
        schemaVersion: 2,
        artifactId: id,
        releaseId: e.releaseId,
        codeSha: e.codeSha,
        target: e.target,
        manifestSha256: e.artifact.manifestSha256,
        repository: policy.repository,
        layout: plannedLayout,
        objects: plan.map((item, index) => ({
          key: item.key,
          contentSha256: item.contentSha256,
          members: item.members.length,
          object: stored[index].object,
          etag: stored[index].etag,
        })),
        bytes: stored.reduce((total, value) => total + value.object.bytes, 0),
        run,
      };
      await db.collection('catalogSeoArchives').doc(`site-v2-${id}`).set(record);
      const after = await rowV2(id);
      if (
        !after ||
        after.manifestSha256 !== record.manifestSha256 ||
        identity(after.objects) !== identity(record.objects)
      )
        throw Error('Retained recovery registration needs readback');
      remember(record);
      const uploaded = stored.filter((value) => value.via === 'upload');
      onEvent({
        action: 'saved',
        schemaVersion: 2,
        objects: plan.length,
        reused: plan.length - uploaded.length,
        reread: stored.filter((value) => value.via === 'read').length,
        uploaded: uploaded.length,
        uploadedBytes: uploaded.reduce((total, value) => total + value.object.bytes, 0),
        storedBytes: record.bytes,
        elapsedMs: Date.now() - started,
      });
    },
  };
}
