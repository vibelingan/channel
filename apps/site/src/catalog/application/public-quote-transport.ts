import { CatalogQuoteSubmissionSchema } from '@vibelingan-channel/shared/catalog-quote';
import { z } from 'zod';
import { apiUrl } from '../../lib/api-url.ts';
import type { CatalogQuoteTransport } from './catalog-quote-transport.ts';
const receipt = z.object({ ok: z.literal(true), requestId: z.string().uuid() }).strict();
const failure = z.object({ ok: z.literal(false), code: z.string().max(100) }).strict();
/** The server saves the immutable inquiry before acknowledgement. No OEM fallback. */
export const submitPublicQuote: CatalogQuoteTransport = async (input) => {
  const parsed = CatalogQuoteSubmissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'validation' };
  try {
    const response = await fetch(apiUrl('/api/catalog-quote-requests'), {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(15000),
    });
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, code: 'uncertain' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          return { ok: false, code: 'uncertain' };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (response.ok) {
      const result = receipt.safeParse(data);
      return result.success ? result.data : { ok: false, code: 'uncertain' };
    }
    const result = failure.safeParse(data);
    return result.success ? result.data : { ok: false, code: 'uncertain' };
  } catch {
    return { ok: false, code: 'uncertain' };
  }
};
