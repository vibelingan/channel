import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { fetchFully } from '../../scripts/smoke-http.mjs';
const siteOrigin = 'https://supplychainsai.com';
const apiOrigin =
  'https://diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com';
const root = '/api/integrations/v1/article-drafts';
const receiptSchema = z
  .object({
    operationId: z.string().regex(/^article-import-[a-f0-9]{64}$/),
    articleId: z.string().regex(/^article-[a-f0-9]{64}$/),
    state: z.literal('ready'),
    importedRevision: z.literal(1),
    createdAt: z.string().datetime(),
    editUrl: z.string(),
    operationUrl: z.string(),
    replayed: z.boolean(),
  })
  .strict();
export class BlogToolError extends Error {}
export function readBlogToolConfig(env) {
  if (
    env.CHANNEL_BLOG_API_ORIGIN !== apiOrigin ||
    env.CHANNEL_BLOG_SITE_ORIGIN !== siteOrigin ||
    !/^([A-Za-z0-9][A-Za-z0-9_-]{0,47})\.[a-f0-9]{64}$/.test(env.CHANNEL_BLOG_CREDENTIAL ?? '') ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(env.CHANNEL_BLOG_INTEGRATION_ID ?? '')
  )
    throw new BlogToolError('网站草稿工具配置不完整，尚未连接。');
  if (
    Boolean(env.CHANNEL_BLOG_TASK_ID) !== Boolean(env.CHANNEL_BLOG_DRAFT_KEY) ||
    (env.CHANNEL_BLOG_DRAFT_KEY && !/^[A-Za-z0-9:_-]{1,128}$/.test(env.CHANNEL_BLOG_DRAFT_KEY)) ||
    (env.CHANNEL_BLOG_TASK_ID && env.CHANNEL_BLOG_TASK_ID.length > 200)
  )
    throw new BlogToolError('本地内容任务绑定不完整。');
  return Object.freeze({
    apiOrigin,
    siteOrigin,
    credential: env.CHANNEL_BLOG_CREDENTIAL,
    integrationId: env.CHANNEL_BLOG_INTEGRATION_ID,
    ...(env.CHANNEL_BLOG_TASK_ID
      ? { taskId: env.CHANNEL_BLOG_TASK_ID, draftKey: env.CHANNEL_BLOG_DRAFT_KEY }
      : {}),
  });
}
function transient(error) {
  const code = error?.cause?.code ?? error?.code;
  return (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENETUNREACH',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(code) ||
    ['AbortError', 'TimeoutError'].includes(error?.name) ||
    / timed out after [0-9]+ms$/.test(error?.message ?? '')
  );
}
export function createBlogToolClient(config, { request = fetchFully, pause = delay } = {}) {
  const trusted = readBlogToolConfig({
    CHANNEL_BLOG_API_ORIGIN: config.apiOrigin,
    CHANNEL_BLOG_SITE_ORIGIN: config.siteOrigin,
    CHANNEL_BLOG_CREDENTIAL: config.credential,
    CHANNEL_BLOG_INTEGRATION_ID: config.integrationId,
    CHANNEL_BLOG_TASK_ID: config.taskId,
    CHANNEL_BLOG_DRAFT_KEY: config.draftKey,
  });
  async function call(method, path, input, expectedOperation) {
    let response;
    const body = input === undefined ? undefined : Buffer.from(JSON.stringify(input));
    if (body && body.length > 256 * 1024) throw new BlogToolError('文章内容超过接口大小限制。');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await request(method, new URL(path, trusted.apiOrigin).href, {
          timeoutMs: 15000,
          maxBytes: 32768,
          redirect: 'error',
          headers: {
            authorization: `Bearer ${trusted.credential}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body } : {}),
        });
      } catch (error) {
        if (!transient(error))
          throw new BlogToolError('回复读取失败，尚未确认保存结果。请检查连接，保留原请求号。');
        response = null;
      }
      if (response && ![502, 503, 504].includes(response.status)) break;
      if (attempt < 2) await pause(250 * (attempt + 1));
    }
    if (!response) throw new BlogToolError('保存结果尚未确认。请保留同一个请求号和正文后再重试。');
    if (![200, 201].includes(response.status))
      throw new BlogToolError(
        `网站拒绝了草稿请求（HTTP ${response.status}）。请检查凭证、内容或额度，不要换请求号重试。`,
      );
    try {
      const envelope = z
        .object({ ok: z.literal(true), data: receiptSchema })
        .strict()
        .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)));
      const r = envelope.data;
      if (
        r.operationId !== expectedOperation ||
        r.articleId !== expectedOperation.replace('article-import-', 'article-') ||
        r.editUrl !== `${trusted.siteOrigin}/admin/?section=articles&article=${r.articleId}` ||
        r.operationUrl !== `${root}/${r.operationId}` ||
        (method === 'GET' ? response.status !== 200 : response.status === (r.replayed ? 201 : 200))
      )
        throw Error('Draft response identity differs');
      return r;
    } catch {
      throw new BlogToolError('网站回复与本次草稿不符，尚不能提供编辑链接。');
    }
  }
  return {
    createDraft: async (input) => {
      if (
        trusted.taskId &&
        (input?.externalTaskId !== trusted.taskId || input?.idempotencyKey !== trusted.draftKey)
      )
        throw new BlogToolError('这次内容任务的编号已固定，不能另换编号重复创建。');
      if (
        !input ||
        typeof input !== 'object' ||
        !/^[A-Za-z0-9:_-]{1,128}$/.test(input.idempotencyKey ?? '')
      )
        throw new BlogToolError('请为同一篇生成结果提供稳定的请求号。');
      const digest = createHash('sha256')
        .update(JSON.stringify(['supplychainsai.com', trusted.integrationId, input.idempotencyKey]))
        .digest('hex');
      return call('POST', root, input, `article-import-${digest}`);
    },
    getImport: async (operationId) => {
      if (!/^article-import-[a-f0-9]{64}$/.test(operationId ?? ''))
        throw new BlogToolError('草稿操作号无效。');
      if (trusted.draftKey) {
        const digest = createHash('sha256')
          .update(JSON.stringify(['supplychainsai.com', trusted.integrationId, trusted.draftKey]))
          .digest('hex');
        if (operationId !== `article-import-${digest}`)
          throw new BlogToolError('只能查询本次隔离内容任务。');
      }
      return call('GET', `${root}/${operationId}`, undefined, operationId);
    },
  };
}
