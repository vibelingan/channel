import { createHash } from 'node:crypto';
import { z } from 'zod';
import { draftInput } from './input.mjs';
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const bindingSchema = z
  .object({
    siteId: z.literal('supplychainsai.com'),
    integrationId: identity.max(48),
    workspaceId: identity,
  })
  .strict();
const sourceSchema = z
  .object({
    documentId: z.number().int().positive().safe(),
    workspaceId: identity,
    article: draftInput.omit({ idempotencyKey: true, externalTaskId: true }),
  })
  .strict();

/** The caller must fetch this document and verify its workspace before calling. */
export function kbDraftRequest(binding, source) {
  const trusted = bindingSchema.parse(binding);
  const document = sourceSchema.parse(source);
  if (document.workspaceId !== trusted.workspaceId)
    throw Error('The KB document belongs to another workspace');
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'channel-blog-kb-v1',
        trusted.siteId,
        trusted.integrationId,
        trusted.workspaceId,
        document.documentId,
      ]),
    )
    .digest('hex');
  // Edits keep the key: the website rejects changed replays instead of overwriting a human draft.
  return draftInput.parse({
    ...document.article,
    externalTaskId: `vibekb:${trusted.workspaceId}:${document.documentId}`,
    idempotencyKey: `kb-draft:${digest}`,
  });
}

export function kbImportOperation(binding, documentId, workspaceId) {
  const trusted = bindingSchema.parse(binding);
  const id = z.number().int().positive().safe().parse(documentId);
  if (identity.parse(workspaceId) !== trusted.workspaceId)
    throw Error('The KB document belongs to another workspace');
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'channel-blog-kb-v1',
        trusted.siteId,
        trusted.integrationId,
        trusted.workspaceId,
        id,
      ]),
    )
    .digest('hex');
  return `article-import-${createHash('sha256')
    .update(JSON.stringify([trusted.siteId, trusted.integrationId, `kb-draft:${digest}`]))
    .digest('hex')}`;
}
