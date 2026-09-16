/**
 * Replacing the assistant's corpus without ever leaving it empty.
 *
 * EXTRACTED SO IT CAN BE TESTED. The algorithm was inline in the ingest script
 * and reachable only by running it against a live engine, so every claim about
 * it — rollback, migration, generation cleanup — rested on a manual run nobody
 * could repeat. Two defects hid there:
 *
 *  1. The original order deleted every attached document, THEN uploaded, THEN
 *     embedded. Any failure in between left the assistant with no corpus and no
 *     error, still answering, ungrounded.
 *  2. The first fix verified only that retrieval returned SOMETHING — which the
 *     still-attached OLD generation satisfied. The script could approve a new
 *     corpus that retrieved nothing and then delete the only one that worked,
 *     recreating the same outcome through a different door.
 *
 * The order is now: upload → embed → prove the NEW generation retrieves →
 * remove the old one. A failure before the proof rolls the new generation back
 * and leaves the previous corpus serving.
 */

/** Marks documents this script owns, and which run created them. */
export const DOCUMENT_NAMESPACE = 'channelkb';
const OWNED_DOCUMENT = new RegExp(`${DOCUMENT_NAMESPACE}-g(\\d+)-`);

/**
 * @typedef {object} CorpusClient
 * @property {() => Promise<string[]>} listAttached      Document paths in the workspace.
 * @property {(doc: {title: string, text: string, docSource: string, description: string}) => Promise<string>} upload
 * @property {(paths: string[]) => Promise<void>} attach
 * @property {(paths: string[]) => Promise<void>} detach
 * @property {(paths: string[]) => Promise<void>} destroy Remove from storage entirely.
 * @property {(query: string) => Promise<{source: string}[]>} search
 */

/**
 * Is this document one of ours?
 *
 * Compared lower-cased: the engine slugs the title it is handed, so `en-US.md`
 * becomes `raw-en-us-home-…`. A case-sensitive match left five of twelve stale
 * documents attached and the corpus duplicated — which pushed a fact out of the
 * top results and stopped the assistant answering a question the site answers.
 */
export function isOwned(docpath, legacyNames) {
  const path = String(docpath ?? '').toLowerCase();
  if (OWNED_DOCUMENT.test(path)) return true;
  // Pre-namespace uploads, from before this script tagged what it created.
  return legacyNames.some((name) => path.includes(`raw-${name.toLowerCase()}-`));
}

export function generationOf(docpath) {
  return Number(OWNED_DOCUMENT.exec(String(docpath ?? '').toLowerCase())?.[1] ?? 0);
}

/**
 * Swap the corpus for a new generation.
 *
 * @param {object} options
 * @param {CorpusClient} options.client
 * @param {{name: string, text: string, docSource: string, description: string}[]} options.documents
 * @param {string[]} options.legacyNames
 * @param {string} options.verifyQuery
 * @param {number} [options.generation]
 * @param {(message: string) => void} [options.log]
 */
export async function refreshCorpus(options) {
  const { client, documents, legacyNames, verifyQuery } = options;
  const generation = options.generation ?? Date.now();
  const log = options.log ?? (() => {});

  const attachedBefore = await client.listAttached();
  const previous = attachedBefore.filter((path) => isOwned(path, legacyNames));
  const foreign = attachedBefore.filter((path) => !isOwned(path, legacyNames));
  if (foreign.length > 0) {
    // Attached by hand through the engine's own console. Not ours to delete.
    log(`leaving ${foreign.length} document(s) this script does not own`);
  }

  const uploaded = [];
  try {
    for (const document of documents) {
      const path = await client.upload({
        // The generation rides in the title, which becomes part of the stored
        // path — so ownership and vintage are readable from the path alone,
        // with no side table to keep in step.
        title: `${DOCUMENT_NAMESPACE}-g${generation}-${document.name}.txt`,
        text: document.text,
        docSource: document.docSource,
        description: document.description,
      });
      if (!path) throw new Error(`upload returned no location for ${document.name}`);
      uploaded.push(path);
      log(`uploaded  ${document.name}`);
    }

    await client.attach(uploaded);

    const attachedAfter = await client.listAttached();
    const missing = uploaded.filter((path) => !attachedAfter.includes(path));
    if (missing.length > 0) {
      throw new Error(`${missing.length} document(s) did not attach to the workspace`);
    }

    const results = await client.search(verifyQuery);
    if (results.length === 0) {
      throw new Error('the new corpus embedded but retrieved nothing');
    }
    const marker = `${DOCUMENT_NAMESPACE}-g${generation}-`;
    const fromNew = results.filter((result) =>
      String(result.source ?? '')
        .toLowerCase()
        .includes(marker),
    );
    if (fromNew.length === 0) {
      // The old generation is still attached here, so a non-empty result proves
      // nothing about the new one.
      throw new Error(
        `retrieval returned ${results.length} result(s), none from generation g${generation} — the previous corpus would have been deleted on this evidence`,
      );
    }
    log(`embedded and verified ${uploaded.length} document(s)`);
  } catch (error) {
    await rollback(client, uploaded, log);
    throw error;
  }

  // Only now is the old generation safe to remove.
  const superseded = previous.filter(
    (path) => generationOf(path) !== generation && !uploaded.includes(path),
  );
  if (superseded.length > 0) {
    await client.detach(superseded).catch(() => undefined);
    await client.destroy(superseded).catch(() => undefined);
    log(`removed ${superseded.length} superseded document(s)`);
  }

  return { generation, uploaded, superseded, foreign };
}

/**
 * Undo a partial generation.
 *
 * Detach and destroy are attempted INDEPENDENTLY. Chained, a failed detach —
 * exactly what happens when the workspace itself is the problem — skipped the
 * destroy and orphaned every upload in storage.
 */
async function rollback(client, uploaded, log) {
  if (uploaded.length === 0) return;
  log(`rolling back ${uploaded.length} uploaded document(s)…`);
  const detached = await client
    .detach(uploaded)
    .then(() => true)
    .catch(() => false);
  const destroyed = await client
    .destroy(uploaded)
    .then(() => true)
    .catch(() => false);
  log(
    detached && destroyed
      ? 'rolled back; the previous corpus is untouched'
      : `rollback incomplete (detached=${detached}, destroyed=${destroyed}); the previous corpus is still attached and still serving`,
  );
}
