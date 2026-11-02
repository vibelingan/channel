import { createHash, timingSafeEqual } from 'node:crypto';
import { isInternalInquirySubmission } from '@vibelingan-channel/ai-contracts/inquiry';
import {
  AssistantInquiryConflict,
  type AssistantInquiryStore,
} from '@vibelingan-channel/db/assistant-inquiry';
import { parseStrictJson } from '@vibelingan-channel/sales-contracts';
import type { SalesRequest, SalesResponse } from './handler.ts';
export function createAssistantIntake(store: AssistantInquiryStore, token: string) {
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
      return reply(400, { code: 'INVALID_REQUEST' });
    }
    if (!isInternalInquirySubmission(input)) return reply(400, { code: 'INVALID_REQUEST' });
    try {
      return reply(200, await store.submit(input));
    } catch (e) {
      return reply(e instanceof AssistantInquiryConflict ? 409 : 503, {
        code: e instanceof AssistantInquiryConflict ? 'SUBMISSION_CHANGED' : 'UNAVAILABLE',
      });
    }
  };
}
