import { assertOrigin, identity, isHash, sha256 } from './input.mjs';

/** This proof is inside compatibility.json, whose bytes are sealed by the release artifact. */
export function assertCatalogAcceptanceProof(proof, { siteOrigin, snapshot }) {
  assertOrigin(siteOrigin);
  if (
    !proof ||
    identity(Object.keys(proof).sort()) !==
      identity([
        'detailEnabled',
        'headsSha256',
        'schemaVersion',
        'siteOrigin',
        'snapshotSha256',
        'writes',
      ]) ||
    proof.schemaVersion !== 1 ||
    proof.siteOrigin !== siteOrigin ||
    typeof proof.detailEnabled !== 'boolean' ||
    !Number.isSafeInteger(proof.writes) ||
    proof.writes < 0 ||
    !isHash(proof.headsSha256) ||
    !isHash(proof.snapshotSha256) ||
    !Buffer.isBuffer(snapshot) ||
    proof.snapshotSha256 !== sha256(snapshot)
  )
    throw Error('Catalog acceptance proof differs from its exact public snapshot');
  return proof;
}
