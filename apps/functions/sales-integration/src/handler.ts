import { safeFileName } from '@vibelingan-channel/media-storage';
import { parseStrictJson } from '@vibelingan-channel/sales-contracts';
import type { AccessDependencies } from '@vibelingan-channel/sales-contracts/access';
import {
  SalesAccessController,
  SalesAccessDenied,
} from '@vibelingan-channel/sales-contracts/access';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { SalesSourceError, readAsset, readInquiry, recordId } from './sources.ts';

export interface SalesRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}
export interface SalesResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export interface SalesDependencies extends AccessDependencies {
  client_id: string;
  business_line: string;
  installation_id: string;
  environment: 'test' | 'production';
  cloud_env_id: string;
  readDoc(
    collection: 'oemProjects' | 'catalogQuoteRequests' | 'files',
    id: string,
  ): Promise<CollectionDoc | null>;
  readFile(storageId: string): Promise<{ body: string; byteSize?: number }>;
  readApprovedProduct(
    id: string,
    page: number,
    pageSize: number,
    revision?: string,
  ): Promise<unknown>;
}

const scopeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/);
const scopeSchema = z
  .object({
    client_id: scopeId,
    business_line: scopeId,
    source_installation_id: scopeId,
    runtime_id: scopeId,
    environment: z.enum(['test', 'production']),
    control_epoch: z.number().int().nonnegative().safe(),
  })
  .strict();
const productQuery = z
  .object({
    ids: z
      .array(z.object({ id: recordId, revision: recordId.optional() }).strict())
      .min(1)
      .max(5),
    page: z.number().int().min(1).max(100000).default(1),
    page_size: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
  Vary: 'Authorization, X-Sales-Connection-Id, X-Sales-Context',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Referrer-Policy': 'no-referrer',
};
const response = (status: number, data: unknown): SalesResponse => ({
  status,
  headers: { ...HEADERS },
  body: Buffer.from(JSON.stringify(data)),
});
const ASSET_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

function assetResponse(
  result: { bytes: Buffer; name: string; mime: string },
  range: string | undefined,
): SalesResponse {
  const total = result.bytes.byteLength;
  let start = 0;
  let end = total - 1;
  if (range !== undefined) {
    const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/.exec(range);
    start = Number(match?.[1]);
    const requestedEnd = Number(match?.[2]);
    if (
      !match ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start >= total ||
      start > requestedEnd
    ) {
      const invalid = response(416, { code: 'INVALID_ASSET_RANGE' });
      invalid.headers['Content-Range'] = `bytes */${total}`;
      invalid.headers['Accept-Ranges'] = 'bytes';
      return invalid;
    }
    end = Math.min(requestedEnd, total - 1);
  }
  if (end - start + 1 > ASSET_RESPONSE_MAX_BYTES)
    return response(413, {
      code: range === undefined ? 'ASSET_RANGE_REQUIRED' : 'ASSET_RANGE_TOO_LARGE',
      max_range_bytes: ASSET_RESPONSE_MAX_BYTES,
      total_bytes: total,
    });
  const name = safeFileName(result.name.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ''));
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return {
    status: range === undefined ? 200 : 206,
    headers: {
      ...HEADERS,
      'Content-Type': result.mime,
      'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encoded}`,
      'Accept-Ranges': 'bytes',
      ...(range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${total}` }),
    },
    body: result.bytes.subarray(start, end + 1),
  };
}

export function createSalesHandler(dependencies: SalesDependencies) {
  const access = new SalesAccessController(dependencies);
  return async (request: SalesRequest): Promise<SalesResponse> => {
    try {
      if ((request.body?.byteLength ?? 0) > 16384) return response(413, { code: 'BODY_TOO_LARGE' });
      if (!request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 2400)
        return response(404, { code: 'NOT_FOUND' });
      const url = new URL(request.url, 'http://sales.invalid');
      if (url.search) return response(400, { code: 'INVALID_REQUEST' });
      const path = url.pathname
        .replace(/^\/api(?=\/)/, '')
        .replace(/^\/integrations\/sales(?=\/)/, '');
      const inquiry = /^\/inquiries\/(oem|product)\/([A-Za-z0-9_-]{1,200})$/.exec(path);
      const asset = /^\/assets\/([A-Za-z0-9_-]{1,1800})$/.exec(path);
      const product = path === '/products/query';
      if (!inquiry && !asset && !product) return response(404, { code: 'NOT_FOUND' });
      if (request.method !== (product ? 'POST' : 'GET'))
        return response(405, { code: 'METHOD_NOT_ALLOWED' });
      const headers = lowerHeaders(request.headers);
      const bearer = /^Bearer ([A-Za-z0-9_-]{32,512})$/i.exec(headers.authorization ?? '');
      const token = bearer?.[1];
      const connectionId = headers['x-sales-connection-id'];
      if (!token || !connectionId) return response(401, { code: 'UNAUTHENTICATED' });
      let scope: z.infer<typeof scopeSchema>;
      try {
        const context = headers['x-sales-context'] ?? '';
        if (!/^[A-Za-z0-9_-]{1,2048}$/.test(context)) throw new Error('invalid');
        const bytes = Buffer.from(context, 'base64url');
        if (bytes.toString('base64url') !== context) throw new Error('invalid');
        scope = scopeSchema.parse(parseStrictJson(bytes.toString('utf8')));
      } catch {
        return response(401, { code: 'UNAUTHENTICATED' });
      }
      const action = inquiry ? 'inquiry.read' : asset ? 'asset.read' : 'product.read';
      return await access.execute(
        { connection_id: connectionId, bearer_token: token, scope, action },
        async (grant) => {
          if (
            grant.client_id !== dependencies.client_id ||
            grant.business_line !== dependencies.business_line ||
            grant.source_installation_id !== dependencies.installation_id ||
            grant.environment !== dependencies.environment
          )
            throw new SalesAccessDenied();
          const inquiryId = inquiry?.[2];
          const assetRef = asset?.[1];
          if (inquiry && inquiryId) {
            const source = await readInquiry(
              dependencies,
              inquiry[1] === 'oem' ? 'oem' : 'product',
              inquiryId,
            );
            return response(200, {
              data: {
                ...source.view,
                owner_scope: {
                  client_id: grant.client_id,
                  business_line: grant.business_line,
                  source_installation_id: grant.source_installation_id,
                },
              },
            });
          }
          if (asset && assetRef) {
            const result = await readAsset(dependencies, assetRef);
            return assetResponse(result, headers.range);
          }
          if (headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
            return response(415, { code: 'CONTENT_TYPE' });
          let query: z.infer<typeof productQuery>;
          try {
            query = productQuery.parse(
              parseStrictJson(
                new TextDecoder('utf-8', { fatal: true }).decode(request.body ?? Buffer.alloc(0)),
              ),
            );
          } catch {
            return response(400, { code: 'INVALID_REQUEST' });
          }
          const items = [];
          for (const target of query.ids)
            items.push(
              await dependencies.readApprovedProduct(
                target.id,
                query.page,
                query.page_size,
                target.revision,
              ),
            );
          const reply = response(200, { data: items });
          return reply.body.byteLength <= 1024 * 1024
            ? reply
            : response(413, { code: 'RESPONSE_TOO_LARGE' });
        },
      );
    } catch (error) {
      if (error instanceof SalesAccessDenied) return response(403, { code: 'FORBIDDEN' });
      if (error instanceof SalesSourceError) return response(error.status, { code: error.code });
      return response(503, { code: 'SERVICE_UNAVAILABLE' });
    }
  };
}

function lowerHeaders(headers: SalesRequest['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (
      typeof value !== 'string' ||
      Object.hasOwn(result, name) ||
      value.length > 4096 ||
      /[\r\n]/.test(value)
    )
      throw new SalesSourceError(401, 'UNAUTHENTICATED');
    result[name] = value;
  }
  return result;
}
