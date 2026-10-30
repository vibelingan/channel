import { identity } from './input.mjs';

/** The clock may use a program only after website and product-page acceptance have both finished. */
export async function activateCatalogRenderer({
  db,
  proof,
  runId,
  executorSha,
  executorRef,
  finishCatalog = /** @type {null | (()=>Promise<void>)} */ (null),
}) {
  if (
    !/^[a-f0-9]{40}$/.test(proof?.codeSha ?? '') ||
    !/^[a-f0-9]{64}$/.test(proof?.manifestSha256 ?? '') ||
    !/^[a-f0-9]{40}$/.test(executorSha) ||
    !['feat/seo-foundation', 'test'].includes(executorRef) ||
    !/^site-[1-9][0-9]*-[1-9][0-9]*$/.test(runId)
  )
    throw Error('Invalid accepted catalog program');
  if (finishCatalog) await finishCatalog();
  const data = {
    codeSha: proof.codeSha,
    executorSha,
    executorRef,
    acceptedRunId: runId,
    manifestSha256: proof.manifestSha256,
    catalogTracked: Boolean(finishCatalog),
  };
  const doc = db.collection('catalogSeoBuilders').doc('active');
  try {
    await doc.set(data);
  } catch {
    /* Readback settles a lost reply for this exact accepted run. */
  }
  const response = await doc.get();
  const row = Array.isArray(response?.data) ? response.data[0] : response?.data;
  if (
    !row ||
    identity(Object.fromEntries(Object.entries(row).filter(([k]) => k !== '_id'))) !==
      identity(data)
  )
    throw Error('Accepted catalog program registration needs readback');
  return data;
}
