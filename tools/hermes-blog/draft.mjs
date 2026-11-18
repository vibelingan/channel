import { createHash } from 'node:crypto';
import { BlogToolError } from './client.mjs';
import { kbDraftRequest, kbImportOperation, kbSourceHash } from './kb-draft.mjs';

/** Save the selected KB document as a private website draft; never publish it. */
export async function saveKbDocument(client, binding, source) {
  const input = kbDraftRequest(binding, source);
  let created;
  try {
    created = await client.createDraft(input);
  } catch (error) {
    // A definite content conflict can be resolved through the separate, guarded
    // source-update route. Auth, rate limits and uncertain delivery still fail.
    if (error?.status !== 409) throw error;
  }
  if (created) return client.getImport(created.operationId);

  const operationId = kbImportOperation(binding, source.documentId, source.workspaceId);
  const current = await client.getPublication(operationId);
  const sourceHash = kbSourceHash(input);
  if (current.sourceHash === sourceHash) return client.getImport(operationId);
  if (!current.canPublish)
    throw new BlogToolError('网站后台已有人修改这篇草稿，已保留人工修改，未用知识库正文覆盖。');
  const requestId = `draft-sync:${createHash('sha256')
    .update(JSON.stringify([operationId, current.revision, current.sourceHash, sourceHash]))
    .digest('hex')}`;
  const updated = await client.syncSource(operationId, {
    requestId,
    expectedRevision: current.revision,
    expectedContentHash: current.contentHash,
    expectedSourceHash: current.sourceHash,
    source: input,
  });
  if (updated.sourceHash !== sourceHash)
    throw new BlogToolError('网站来源版本已发生变化，请核对同一篇草稿，未另建文章或发布。');
  const confirmed = await client.getImport(operationId);
  return { ...confirmed, revision: updated.revision, sourceSynced: true };
}
