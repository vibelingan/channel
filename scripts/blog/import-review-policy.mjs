import { identity } from '../release/input.mjs';
export const IMPORT_ACCEPTANCE = Object.freeze({
  integrationId: 'hermes-local-20261026',
  taskId: 'channel-blog-acceptance-20261026',
  draftKey: 'hermes-local-20261026-v1',
  marker: 'Human review: confirm the approved requirements before requesting a quotation.',
});
export function ownedImportFixture({ operationId, operation, row, draft }) {
  const p = IMPORT_ACCEPTANCE;
  const hash = identity;
  const expected = `article-import-${hash(['supplychainsai.com', p.integrationId, p.draftKey])}`;
  const originalHeading = /^## (.+)$/m.exec(row?.source?.body ?? '')?.[1];
  const blocks = draft?.content?.body?.document?.content ?? [];
  const text = (node) => (node?.content ?? []).map((n) => n.text ?? '').join('');
  const first = blocks.find((n) => n.type === 'heading');
  const repairHeading =
    draft?.revision === 2 &&
    blocks.some((node) => node.type === 'heading' && text(node) === p.marker + originalHeading);
  const reviewed =
    first &&
    text(first) === originalHeading &&
    blocks.at(-1)?.type === 'paragraph' &&
    text(blocks.at(-1)) === p.marker;

  if (
    !['review', 'publish', 'withdraw'].includes(operation) ||
    !originalHeading ||
    operationId !== expected ||
    row?._id !== expected ||
    row?.integrationId !== p.integrationId ||
    row?.siteId !== 'supplychainsai.com' ||
    row?.importedRevision !== 1 ||
    row?.requestHash !== hash(row?.source) ||
    row?.converterVersion !== 'article-import-v1' ||
    row?.source?.externalTaskId !== p.taskId ||
    row?.source?.idempotencyKey !== p.draftKey ||
    row?.articleId !== expected.replace('article-import-', 'article-') ||
    draft?.id !== row.articleId ||
    draft?.createdBy !== `integration:${p.integrationId}` ||
    draft?.content?.slug !== 'oem-brief-hermes-acceptance-20261026' ||
    draft?.content?.authorName !== 'Diversity Technology Limited' ||
    !Number.isSafeInteger(draft?.revision) ||
    (operation === 'review' && draft.revision !== 1 && !repairHeading) ||
    (operation === 'publish' && (![2, 3].includes(draft.revision) || !reviewed)) ||
    (operation !== 'withdraw' && draft.published !== null) ||
    (operation === 'withdraw' && (!draft.published || draft.revision < 2))
  )
    throw Error('Only the exact locally generated acceptance draft may be operated');
  return {
    operation,
    operationId,
    articleId: draft.id,
    revision: draft.revision,
    title: draft.content.title,
    slug: draft.content.slug,
    editUrl: `https://supplychainsai.com/admin/?section=articles&article=${draft.id}`,
    marker: p.marker,
    originalHeading,
    repairHeading: repairHeading ? originalHeading : null,
  };
}
