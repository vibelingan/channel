import { CatalogQuoteSubmissionSchema } from '@vibelingan-channel/shared/catalog-quote';
import { z } from 'zod';
import { apiUrl } from '../../lib/api-url.ts';
import type { CatalogQuoteTransport } from './catalog-quote-transport.ts';

const receipt = z.object({ ok: z.literal(true), requestId: z.string().uuid() }).strict();
const failure = z.object({ ok: z.literal(false), code: z.string().max(100) }).strict();
export const submitLocalQuote: CatalogQuoteTransport = async (input) => {
  const url = new URL(apiUrl('/api/catalog-quote-requests'), window.location.origin);
  if (
    !import.meta.env.DEV ||
    !['127.0.0.1', 'localhost'].includes(window.location.hostname) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.protocol !== 'http:' ||
    url.port !== '3013'
  )
    return { ok: false, code: 'local-only' };
  const parsed = CatalogQuoteSubmissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'validation' };
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Local-Catalog-Quote': '1' },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(15000),
    });
    const data: unknown = await response.json();
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
