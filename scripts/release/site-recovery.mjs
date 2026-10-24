import { createHash } from 'node:crypto';
import { identity, readHostingObject, sha256 } from './input.mjs';
import { normalizePolicy } from './ledger.mjs';
import { ownedSitePaths } from './site-files.mjs';

/** A failed candidate supplies ownership evidence only; it never becomes a restore target. */
export function assertJournaledSiteCandidate({ run, input, policy, dirtyRunId }) {
  if (
    !dirtyRunId ||
    run?.runId !== dirtyRunId ||
    run.state !== 'FAILED' ||
    run.targetId !== normalizePolicy(policy).targetId ||
    run.scopeKey !== 'site' ||
    run.accepted ||
    input.acceptedSeal ||
    identity(run.composition?.static?.artifact) !== identity(input.envelope.artifact) ||
    run.composition.static.codeSha !== input.envelope.codeSha ||
    run.composition.static.releaseId !== input.envelope.releaseId
  )
    throw Error('Failed site artifact does not match the recorded dirty release');
}

/** Every affected live file must still be exactly A or B before recovery can write. */
export function assertSiteRecoveryChain({ chain, policy, dirtyRunId }) {
  if (!Array.isArray(chain) || !chain.length || chain.length > 16)
    throw Error('Complete failed release chain required');
  let expected = dirtyRunId;
  const seen = new Set();
  for (const item of chain) {
    if (seen.has(expected)) throw Error('Cyclic recovery history');
    seen.add(expected);
    assertJournaledSiteCandidate({ ...item, policy, dirtyRunId: expected });
    expected = item.run.failedRunId;
  }
  if (expected) throw Error('Incomplete failed release chain');
}

export function assertDirtySiteInventory({ baseline, failed, inventory }) {
  const originals = new Map(baseline.staticManifest.entries.map((e) => [e.path, e]));
  const candidates = (Array.isArray(failed) ? failed : [failed]).map((source) => ({
    source,
    entries: new Map(source.staticManifest.entries.map((e) => [e.path, e])),
  }));
  const objects = new Map(inventory.map((e) => [e.path, e]));
  const matches = (source, entry, current) => {
    const bytes = readHostingObject(source.directory, entry);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
      throw Error('Corrupt recovery input');
    return (
      current.bytes === entry.bytes &&
      (current.etag.replaceAll('"', '').toLowerCase() ===
        createHash('md5').update(bytes).digest('hex') ||
        (entry.objectVersion?.etag === current.etag &&
          entry.objectVersion.lastModified === current.lastModified))
    );
  };
  const paths = new Set(candidates.flatMap(({ source }) => ownedSitePaths(source, baseline)));
  for (const path of paths) {
    const a = originals.get(path);
    const bs = candidates.filter((c) => c.entries.has(path));
    const current = objects.get(path);
    if (!current) {
      if (a && bs.length === candidates.length)
        throw Object.assign(Error('An expected site file disappeared'), {
          code: 'STOP_EXTERNAL_CHANGE',
        });
      continue;
    }
    if (
      !(
        (a && matches(baseline, a, current)) ||
        bs.some((c) => matches(c.source, c.entries.get(path), current))
      )
    )
      throw Object.assign(Error('Affected site file differs from both archived versions'), {
        code: 'STOP_EXTERNAL_CHANGE',
      });
  }
}
