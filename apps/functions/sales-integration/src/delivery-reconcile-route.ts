import { createHash, timingSafeEqual } from 'node:crypto';
import { parseStrictJson } from '@vibelingan-channel/sales-contracts';
import type { SalesRequest, SalesResponse } from './handler.ts';
import type { WebsiteDelivery } from './website-delivery.ts';

/** One fixed, bounded outbox page. Never accepts a customer, source event or target URL. */
export function createDeliveryReconcileRoute(
  worker: Pick<WebsiteDelivery, 'tick'>,
  token: string,
  forbiddenTokens: Array<string | undefined> = [],
) {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(token) || forbiddenTokens.includes(token))
    throw new Error('Dedicated reconciliation credential required');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const respond = (status: number, data: unknown): SalesResponse => ({
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
    body: Buffer.from(JSON.stringify(data)),
  });
  return async (request: SalesRequest): Promise<SalesResponse> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const key = name.toLowerCase();
      if (headers[key] !== undefined || Array.isArray(value))
        return respond(401, { code: 'UNAUTHENTICATED' });
      if (value !== undefined) headers[key] = value;
    }
    const supplied = /^Bearer ([A-Za-z0-9_-]{32,512})$/i.exec(headers.authorization ?? '')?.[1];
    if (!supplied || !timingSafeEqual(digest(supplied), digest(token)))
      return respond(401, { code: 'UNAUTHENTICATED' });
    if (request.method !== 'POST') return respond(405, { code: 'METHOD_NOT_ALLOWED' });
    if (headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return respond(415, { code: 'CONTENT_TYPE' });
    if ((request.body?.byteLength ?? 0) > 256) return respond(413, { code: 'BODY_TOO_LARGE' });
    try {
      const input = parseStrictJson(
        new TextDecoder('utf-8', { fatal: true }).decode(request.body ?? Buffer.alloc(0)),
      );
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
        return respond(400, { code: 'INVALID_REQUEST' });
    } catch {
      return respond(400, { code: 'INVALID_REQUEST' });
    }
    try {
      // Five deliveries at the sender's five-second maximum, below the HTTP
      // function's 60-second invocation limit; the Hub retries every 30 seconds.
      return respond(200, await worker.tick(5));
    } catch {
      return respond(503, { code: 'UNAVAILABLE' });
    }
  };
}
