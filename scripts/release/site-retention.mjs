import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { identity, sha256 } from './input.mjs';
const proofs = new WeakSet();

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

export function createSiteRetention({ db, objects, policy }) {
  const row = async (id) => {
    if (!/^[1-9][0-9]*$/.test(id)) throw Error('Exact retained artifact ID required');
    const response = await db.collection('catalogSeoArchives').doc(id).get();
    if (!response || !Object.hasOwn(response, 'data'))
      throw Error('Retained artifact lookup failed');
    return Array.isArray(response.data) ? response.data[0] : response.data;
  };
  const load = async (record, directory) => {
    if (
      record?.schemaVersion !== 1 ||
      record.target?.envId !== policy.envId ||
      record.target.siteOrigin !== policy.siteOrigin ||
      record.repository !== policy.repository ||
      record.archiveObject?.sha256 !== record.archiveSha256 ||
      !/^[a-f0-9]{64}$/.test(record.manifestSha256 ?? '')
    )
      throw Error('Retained artifact record differs');
    const archive = await objects.get(record.archiveObject);
    if (archive.length !== record.bytes || sha256(archive) !== record.archiveSha256)
      throw Error('Retained release ZIP differs');
    const file = `${directory}.retained.zip`;
    writeFileSync(file, archive, { flag: 'wx', mode: 0o600 });
    execFileSync(
      'python3',
      [new URL('./extract-site-payload.py', import.meta.url).pathname, file, directory],
      { stdio: 'pipe' },
    );
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
  return {
    async download(id, directory) {
      const record = await row(String(id));
      return record ? load(record, directory) : null;
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
      const existing = await row(e.artifact.artifactId);
      if (existing) {
        if (existing.manifestSha256 !== e.artifact.manifestSha256)
          throw Error('Retained artifact cannot be replaced');
        return;
      }
      const file = join(dirname(directory), `${e.artifact.artifactId}-retention.zip`);
      execFileSync(
        'python3',
        [new URL('./pack-site-payload.py', import.meta.url).pathname, directory, file],
        { stdio: 'pipe' },
      );
      const archive = readFileSync(file);
      const archiveObject = await objects.put(archive);
      const record = {
        schemaVersion: 1,
        artifactId: e.artifact.artifactId,
        releaseId: e.releaseId,
        codeSha: e.codeSha,
        target: e.target,
        manifestSha256: e.artifact.manifestSha256,
        archiveSha256: archiveObject.sha256,
        bytes: archive.length,
        repository: policy.repository,
        archiveObject,
        run,
      };
      await load(record, join(dirname(directory), `${e.artifact.artifactId}-retention-readback`));
      await db.collection('catalogSeoArchives').doc(e.artifact.artifactId).set(record);
      const after = await row(e.artifact.artifactId);
      if (
        !after ||
        after.archiveSha256 !== record.archiveSha256 ||
        after.archiveObject?.fileID !== archiveObject.fileID ||
        after.manifestSha256 !== record.manifestSha256
      )
        throw Error('Retained recovery registration needs readback');
    },
  };
}
