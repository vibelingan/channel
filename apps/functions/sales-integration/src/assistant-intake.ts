import { createHash, timingSafeEqual } from 'node:crypto';
import { isInternalInquirySubmission } from '@vibelingan-channel/ai-contracts/inquiry';
import {
  AssistantInquiryConflict,
  AssistantInquiryRejected,
  type AssistantInquiryStore,
} from '@vibelingan-channel/db/assistant-inquiry';
import { parseStrictJson } from '@vibelingan-channel/sales-contracts';
import type { SalesRequest, SalesResponse } from './handler.ts';
/**
 * Acceptance and manual trials save real-looking contact details under a
 * server-fixed test installation. Test status comes from that installation,
 * never from the company name, email domain or anything the visitor typed.
 */
export function testScopeInquiryStore(
  store: AssistantInquiryStore,
  scope: { environment: 'test' | 'production' },
): AssistantInquiryStore {
  if (scope.environment !== 'test') throw new Error('Test intake requires a test installation');
  return store;
}
export function createAssistantIntake(
  store: AssistantInquiryStore,
  token: string,
  afterSaved?: (kind: 'oem' | 'product', id: string) => Promise<void>,
) {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new Error('Invalid assistant intake token');
  const digest = (v: string) => createHash('sha256').update(v).digest();
  const reply = (status: number, body: unknown): SalesResponse => ({
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body: Buffer.from(JSON.stringify(body)),
  });
  const invalid = { code: 'INVALID_REQUEST', outcome: 'not_started', reason: 'INVALID_DETAILS' };
  return async (request: SalesRequest): Promise<SalesResponse> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      const key = k.toLowerCase();
      if (headers[key] !== undefined || Array.isArray(v))
        return reply(401, { code: 'UNAUTHENTICATED' });
      if (v !== undefined) headers[key] = v;
    }
    const supplied = /^Bearer ([A-Za-z0-9_-]{32,512})$/i.exec(headers.authorization ?? '')?.[1];
    if (!supplied || !timingSafeEqual(digest(supplied), digest(token)))
      return reply(401, { code: 'UNAUTHENTICATED' });
    if (request.method !== 'POST') return reply(405, { code: 'METHOD_NOT_ALLOWED' });
    if (headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return reply(415, { code: 'CONTENT_TYPE' });
    if ((request.body?.byteLength ?? 0) > 32768) return reply(413, { code: 'BODY_TOO_LARGE' });
    let input: unknown;
    try {
      input = parseStrictJson(
        new TextDecoder('utf-8', { fatal: true }).decode(request.body ?? Buffer.alloc(0)),
      );
    } catch {
      return reply(400, invalid);
    }
    if (!isInternalInquirySubmission(input)) return reply(400, invalid);
    try {
      const result = await store.submit(input);
      try {
        await afterSaved?.('oem', result.reference);
      } catch {
        console.warn('Sales immediate delivery deferred to reconciliation');
      }
      return reply(200, result);
    } catch (e) {
      // Only a refusal raised before any write may say "not saved"; anything
      // else might have committed and is reported as unknown.
      if (e instanceof AssistantInquiryRejected)
        return reply(422, { code: 'REJECTED', outcome: 'not_started', reason: e.reason });
      return reply(e instanceof AssistantInquiryConflict ? 409 : 503, {
        code: e instanceof AssistantInquiryConflict ? 'SUBMISSION_CHANGED' : 'UNAVAILABLE',
        outcome: 'unknown',
      });
    }
  };
}
