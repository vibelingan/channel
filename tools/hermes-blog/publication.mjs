import { createHash } from 'node:crypto';
import { fetchFully } from '../../scripts/smoke-http.mjs';
import { BlogToolError } from './client.mjs';
import { kbDraftRequest, kbImportOperation, kbSourceHash } from './kb-draft.mjs';
import { publicationApproval } from './publication-contract.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function verifyPublicArticle(receipt, title, request = fetchFully) {
  try {
    if (receipt.state !== 'published' || !receipt.publicUrl)
      throw new BlogToolError('本次请求没有得到当前公开文章，未重新发布旧版本。');
    const response = await request('GET', receipt.publicUrl, {
      timeoutMs: 20000,
      maxBytes: 2 * 1024 * 1024,
      redirect: 'error',
      headers: { 'cache-control': 'no-cache' },
    });
    const html = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
    const canonical = [...html.matchAll(/<link\b[^>]*>/gi)].find(([tag]) =>
      /\brel=["']canonical["']/i.test(tag),
    )?.[0];
    if (
      response.status !== 200 ||
      !canonical ||
      (!canonical.includes(`href="${receipt.publicUrl}"`) &&
        !canonical.includes(`href='${receipt.publicUrl}'`))
    )
      throw new BlogToolError(
        '发布已提交，但公开网址的实际页面尚未确认。保留原任务查询，不另建文章。',
      );
    const nodes = [
      ...html.matchAll(
        /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      ),
    ].flatMap((match) => {
      const value = JSON.parse(match[1]);
      return Array.isArray(value) ? value : (value['@graph'] ?? [value]);
    });
    if (
      !nodes.some(
        (node) =>
          [node['@type']].flat().includes('Article') &&
          node.headline === title &&
          node.dateModified === receipt.publishedModifiedAt,
      )
    )
      throw new BlogToolError('网站保存了发布结果，公开页版本尚未对应。保留原任务，不重复创建。');
    return { ...receipt, publicVerified: true };
  } catch (error) {
    const failure = new BlogToolError(
      '发布已提交，但公开页面尚未确认；保留同一文章和原任务查询，不另建文。',
    );
    failure.receipt = { ...receipt, publicVerified: false };
    throw failure;
  }
}

/** Transfers the exact selected KB source; it never writes or rewrites article prose. */
export async function publishKbDocument(
  client,
  binding,
  source,
  approvalInput,
  { request = fetchFully } = {},
) {
  const approval = publicationApproval.parse(approvalInput);
  const operation = approval.decision === 'withdraw-now' ? 'withdraw' : 'publish';
  const original = kbDraftRequest(binding, source);
  const operationId = kbImportOperation(binding, source.documentId, source.workspaceId);
  let current;
  try {
    current = await client.getPublication(operationId);
  } catch (error) {
    if (error.status !== 404 || operation !== 'publish') throw error;
    await client.createDraft(original);
    current = await client.getPublication(operationId);
  }
  const sourceHash = kbSourceHash(original);
  if (current.sourceHash !== sourceHash) {
    if (operation === 'withdraw')
      throw new BlogToolError('知识库已变更，不能用不同稿件撤回当前文章，请核对指定版本。');
    if (!current.canPublish)
      throw new BlogToolError('后台已经有人修改这篇文章，保留人工修改，旧来源未覆盖。');
    current = await client.syncSource(operationId, {
      requestId: `source-sync:${hash([source.documentId, approval.messageRef, sourceHash])}`,
      expectedRevision: current.revision,
      expectedContentHash: current.contentHash,
      expectedSourceHash: current.sourceHash,
      source: original,
    });
  }
  if (
    !current.canPublish &&
    !(current.state === 'published' && current.publishedContentHash === current.contentHash)
  )
    throw new BlogToolError('后台已经有人修改这篇文章，尚未发布人工未确认的版本。');
  if (
    operation === 'publish' &&
    current.state === 'published' &&
    current.publishedContentHash === current.contentHash
  )
    return {
      ...(await verifyPublicArticle(current, source.article.title, request)),
      replayed: true,
      alreadyPublished: true,
    };
  if (operation === 'withdraw' && current.state !== 'published')
    return { ...current, replayed: true };
  const result = await client.changePublication(operationId, {
    operation,
    requestId: `${operation}:${hash([source.documentId, approval.messageRef])}`,
    expectedRevision: current.revision,
    expectedContentHash: current.contentHash,
    expectedSourceHash: sourceHash,
    approval,
  });
  if (operation === 'withdraw') return result;
  if (result.publishedContentHash !== current.contentHash)
    throw new BlogToolError('当前公开版本与本次指定成稿不同；没有覆盖后来变更。请核对原任务。');
  return verifyPublicArticle(result, source.article.title, request);
}
