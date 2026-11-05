import { ArticleImportError } from '@vibelingan-channel/articles/import';
import type { createArticleImportService } from '@vibelingan-channel/articles/import-store';
type ImportService = ReturnType<typeof createArticleImportService>;
type Service = Pick<ImportService, 'create' | 'get'> &
  Partial<Pick<ImportService, 'rotate'>> & {
    images?: {
      state(credential: string, operationId: string): Promise<unknown>;
      intent(credential: string, operationId: string, input: unknown): Promise<unknown>;
      complete(credential: string, operationId: string, input: unknown): Promise<unknown>;
      attach(credential: string, operationId: string, input: unknown): Promise<unknown>;
    };
  };
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}
const root = '/api/integrations/v1/article-drafts';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const response = (
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  },
  body: JSON.stringify(data),
  isBase64Encoded: false,
});
const failure = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) => response(status, { ok: false, error: { code, message } }, headers);
/** Server-to-server draft and credential routes never accept browser admin action envelopes. */
export async function handleArticleImportEvent(
  event: unknown,
  service: Service | undefined,
  codeSha = 'local',
): Promise<HttpResponse> {
  try {
    if (!record(event) || typeof event.httpMethod !== 'string' || typeof event.path !== 'string')
      return failure(400, 'INVALID_REQUEST', 'An HTTP request is required.');
    const method = event.httpMethod.toUpperCase();
    const path = event.path;
    const imageRoute = new RegExp(
      `^${root}/(article-import-[a-f0-9]{64})/images/(state|intent|complete|attach)$`,
    ).exec(path);
    if (
      path !== root &&
      !new RegExp(`^${root}/article-import-[a-f0-9]{64}$`).test(path) &&
      path !== `${root}/health` &&
      path !== `${root}/credential-rotation` &&
      !imageRoute
    )
      return failure(404, 'NOT_FOUND', 'Route not found.');
    if (!service) return failure(503, 'UNAVAILABLE', 'Draft integration is not enabled.');
    if (record(event.queryStringParameters) && Object.keys(event.queryStringParameters).length)
      return failure(400, 'INVALID_REQUEST', 'Query parameters are not supported.');
    if (method === 'GET' && path === `${root}/health`) {
      if (!/^[a-f0-9]{40}$/.test(codeSha))
        return failure(503, 'UNAVAILABLE', 'Release identity is unavailable.');
      return response(200, {
        ok: true,
        data: { service: 'article-import', releaseId: codeSha, apiContract: 'article-drafts-v1' },
      });
    }
    const isPost =
      path === root ||
      path === `${root}/credential-rotation` ||
      Boolean(imageRoute && imageRoute[2] !== 'state');
    if (isPost ? method !== 'POST' : method !== 'GET')
      return failure(405, 'INVALID_REQUEST', 'Method not allowed.', {
        Allow: isPost ? 'POST' : 'GET',
      });
    const headers: Record<string, string> = {};
    if (record(event.headers))
      for (const [key, value] of Object.entries(event.headers)) {
        const name = key.toLowerCase();
        if (typeof value !== 'string' || Object.hasOwn(headers, name))
          return failure(400, 'INVALID_REQUEST', 'Invalid request headers.');
        headers[name] = value;
      }
    const credential = headers.authorization?.match(
      /^Bearer ([A-Za-z0-9][A-Za-z0-9_-]{0,47}\.[a-f0-9]{64})$/,
    )?.[1];
    if (!credential) return failure(401, 'UNAUTHORIZED', 'Draft integration is unavailable.');
    if (imageRoute && !service.images)
      return failure(503, 'UNAVAILABLE', 'Draft image integration is not enabled.');
    if (method === 'GET') {
      if (event.body !== undefined && event.body !== null && event.body !== '')
        return failure(400, 'INVALID_REQUEST', 'GET requests cannot contain an article.');
      const result =
        imageRoute && service.images
          ? await service.images.state(credential, String(imageRoute[1]))
          : await service.get(credential, path.slice(root.length + 1));
      return response(200, { ok: true, data: result });
    }
    if (headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return failure(415, 'INVALID_REQUEST', 'JSON content type is required.');
    if (typeof event.body !== 'string')
      return failure(400, 'INVALID_REQUEST', 'JSON body is required.');
    let bytes: Buffer;
    if (event.isBase64Encoded === true) {
      if (event.body.length > Math.ceil((256 * 1024) / 3) * 4)
        return failure(413, 'TOO_LARGE', 'Article request is too large.');
      bytes = Buffer.from(event.body, 'base64');
      if (bytes.toString('base64') !== event.body)
        return failure(400, 'INVALID_REQUEST', 'Invalid base64 body.');
    } else {
      if (event.isBase64Encoded !== undefined && event.isBase64Encoded !== false)
        return failure(400, 'INVALID_REQUEST', 'Invalid body encoding.');
      bytes = Buffer.from(event.body, 'utf8');
    }
    if (bytes.length > 256 * 1024)
      return failure(413, 'TOO_LARGE', 'Article request is too large.');
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return failure(400, 'INVALID_REQUEST', 'Invalid UTF-8 JSON body.');
    }
    if (path === `${root}/credential-rotation`) {
      if (!service.rotate)
        return failure(503, 'UNAVAILABLE', 'Credential maintenance is not enabled.');
      return response(200, { ok: true, data: await service.rotate(credential, body) });
    }
    if (imageRoute && service.images) {
      const id = String(imageRoute[1]);
      const action = imageRoute[2];
      const result =
        action === 'intent'
          ? await service.images.intent(credential, id, body)
          : action === 'complete'
            ? await service.images.complete(credential, id, body)
            : await service.images.attach(credential, id, body);
      return response(200, { ok: true, data: result });
    }
    const result = await service.create(credential, body);
    return response(result.replayed ? 200 : 201, { ok: true, data: result });
  } catch (error) {
    if (error instanceof ArticleImportError) {
      const statuses = {
        INVALID_REQUEST: 400,
        UNAUTHORIZED: 401,
        NOT_FOUND: 404,
        CONFLICT: 409,
        RATE_LIMITED: 429,
        UNAVAILABLE: 503,
      };
      return failure(
        statuses[error.code],
        error.code,
        error.message,
        error.code === 'RATE_LIMITED' &&
          Number.isSafeInteger(error.retryAfterSeconds) &&
          Number(error.retryAfterSeconds) > 0
          ? { 'Retry-After': String(error.retryAfterSeconds) }
          : {},
      );
    }
    return failure(503, 'UNAVAILABLE', 'Draft storage could not be confirmed.');
  }
}
