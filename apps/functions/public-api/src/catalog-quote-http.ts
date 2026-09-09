import { submitCatalogQuote } from '@vibelingan-channel/db';
import type { HttpResponse, PublicHttpConfig } from './http-adapter.ts';

export async function handleQuoteEvent(
  event: Record<string, unknown>,
  config: PublicHttpConfig,
  save = submitCatalogQuote,
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After',
  };
  const reply = (statusCode: number, body: unknown): HttpResponse => ({
    statusCode,
    headers,
    body: body === null ? '' : JSON.stringify(body),
    isBase64Encoded: false,
  });
  const fail = (status: number, code: string) => reply(status, { ok: false, code });
  if (config.enableInquiries !== true) return fail(404, 'not-enabled');
  const entries =
    typeof event.headers === 'object' && event.headers !== null
      ? Object.entries(event.headers)
      : [];
  const header = (name: string) => entries.find(([key]) => key.toLowerCase() === name)?.[1];
  const origin = header('origin');
  // Explicit browser origin gate; this is not authentication or a bot defense.
  if (typeof origin !== 'string' || !config.corsAllowedOrigins?.includes(origin) || origin === '*')
    return fail(403, 'origin');
  headers['Access-Control-Allow-Origin'] = origin;
  const method = String(event.httpMethod ?? event.method ?? 'GET').toUpperCase();
  if (method === 'OPTIONS') return reply(204, null);
  if (method !== 'POST') return fail(405, 'method');
  const contentType = header('content-type');
  if (
    typeof contentType !== 'string' ||
    contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    return fail(415, 'content-type');
  // Bound before decoding, then bound UTF-8 bytes again. Never log buyer input.
  if (typeof event.body !== 'string') return fail(400, 'invalid-json');
  if (Buffer.byteLength(event.body, 'utf8') > (event.isBase64Encoded === true ? 21848 : 16384))
    return fail(413, 'body-too-large');
  let input: unknown;
  try {
    const body =
      event.isBase64Encoded === true
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
    if (Buffer.byteLength(body, 'utf8') > 16384) return fail(413, 'body-too-large');
    input = JSON.parse(body);
  } catch {
    return fail(400, 'invalid-json');
  }
  try {
    const result = await save(input);
    if (result.ok) return reply(200, result);
    if (result.code === 'rate-limit') headers['Retry-After'] = '60';
    return reply(
      result.code === 'validation' ? 400 : result.code === 'rate-limit' ? 429 : 409,
      result,
    );
  } catch {
    return fail(500, 'save-failed');
  }
}
