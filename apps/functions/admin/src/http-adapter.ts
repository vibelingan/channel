import { type ApiErr, type ApiResult, err } from '@vibelingan-channel/shared';
import type { AdminConfig, AdminRequest, RequestContext } from './handler.ts';

export interface AdminHttpConfig extends AdminConfig {
  corsAllowedOrigins?: readonly string[];
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

export type AdminRequestHandler = (
  req: AdminRequest,
  config: AdminConfig,
  context?: RequestContext,
) => Promise<ApiResult<unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function headerValue(headers: unknown, name: string): string {
  if (!isRecord(headers)) return '';
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === 'string') return value;
  }
  return '';
}

function requestMethod(event: Record<string, unknown>): string {
  const direct = event.httpMethod ?? event.method;
  if (typeof direct === 'string') return direct.toUpperCase();
  const context = event.requestContext;
  if (isRecord(context) && typeof context.httpMethod === 'string') {
    return context.httpMethod.toUpperCase();
  }
  return 'POST';
}

function requestOrigin(event: Record<string, unknown>): string {
  return headerValue(event.headers, 'origin');
}

/**
 * Best-effort client IP for public-endpoint abuse control. Prefers the first
 * `x-forwarded-for` hop (the original client through the gateway/CDN), then the
 * platform `requestContext` sourceIp. Returns '' when no signal is available, in
 * which case the handler falls back to global-only caps.
 */
function clientIp(event: Record<string, unknown>): string {
  const forwarded = headerValue(event.headers, 'x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const context = event.requestContext;
  if (isRecord(context)) {
    if (typeof context.sourceIp === 'string' && context.sourceIp) return context.sourceIp;
    const identity = context.identity;
    if (isRecord(identity) && typeof identity.sourceIp === 'string' && identity.sourceIp) {
      return identity.sourceIp;
    }
  }
  return '';
}

function isHttpEnvelope(event: unknown): event is Record<string, unknown> {
  if (!isRecord(event)) return false;
  return (
    hasKey(event, 'body') ||
    hasKey(event, 'headers') ||
    hasKey(event, 'httpMethod') ||
    hasKey(event, 'method') ||
    hasKey(event, 'isBase64Encoded') ||
    hasKey(event, 'requestContext')
  );
}

function isAdminRequest(value: unknown): value is AdminRequest {
  return isRecord(value) && typeof value.action === 'string';
}

function isApiErr(value: AdminRequest | ApiErr): value is ApiErr {
  return isRecord(value) && value.ok === false;
}

function toAdminRequest(value: unknown): AdminRequest | ApiErr {
  if (!isRecord(value)) return err('BAD_REQUEST', 'Request body must be a JSON object.');
  if (typeof value.action !== 'string') {
    return err('BAD_REQUEST', 'Request body must include an action.');
  }

  const req: AdminRequest = { action: value.action };
  if (hasKey(value, 'data')) req.data = value.data;
  if (typeof value.token === 'string') req.token = value.token;
  return req;
}

function parseHttpBody(event: Record<string, unknown>): AdminRequest | ApiErr {
  const body = event.body;
  if (body === undefined || body === null || body === '') return { action: '' };
  if (isRecord(body)) return toAdminRequest(body);
  if (typeof body !== 'string') return err('BAD_REQUEST', 'Request body must be JSON.');

  const text = event.isBase64Encoded === true ? Buffer.from(body, 'base64').toString('utf8') : body;
  try {
    return toAdminRequest(JSON.parse(text) as unknown);
  } catch {
    return err('BAD_REQUEST', 'Invalid JSON body.');
  }
}

function errorStatus(result: ApiResult<unknown>): number {
  if (result.ok) return 200;
  switch (result.error.code) {
    case 'BAD_REQUEST':
    case 'VALIDATION_ERROR':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
    case 'UNKNOWN_COLLECTION':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL_ERROR':
      return 500;
    default: {
      const _exhaustive: never = result.error.code;
      throw new Error(`Unhandled error code: ${_exhaustive}`);
    }
  }
}

function corsOrigin(event: Record<string, unknown>, config: AdminHttpConfig): string {
  const origins = config.corsAllowedOrigins ?? [];
  if (origins.length === 0) return '*';
  const origin = requestOrigin(event);
  if (origin && origins.includes(origin)) return origin;
  return origins[0] ?? '*';
}

function responseHeaders(
  event: Record<string, unknown>,
  config: AdminHttpConfig,
): Record<string, string> {
  return {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Origin': corsOrigin(event, config),
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  };
}

function jsonResponse(
  event: Record<string, unknown>,
  config: AdminHttpConfig,
  result: ApiResult<unknown>,
  statusCode = errorStatus(result),
): HttpResponse {
  const headers = responseHeaders(event, config);
  if (!result.ok && typeof result.error.retryAfterSeconds === 'number') {
    headers['Retry-After'] = String(result.error.retryAfterSeconds);
  }
  return {
    statusCode,
    headers,
    body: JSON.stringify(result),
    isBase64Encoded: false,
  };
}

function optionsResponse(event: Record<string, unknown>, config: AdminHttpConfig): HttpResponse {
  return {
    statusCode: 204,
    headers: responseHeaders(event, config),
    body: '',
    isBase64Encoded: false,
  };
}

export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export async function handleAdminFunctionEvent(
  event: unknown,
  config: AdminHttpConfig,
  handler: AdminRequestHandler,
): Promise<ApiResult<unknown> | HttpResponse> {
  if (!isHttpEnvelope(event)) {
    return handler(isAdminRequest(event) ? event : { action: '' }, config);
  }

  const method = requestMethod(event);
  if (method === 'OPTIONS') return optionsResponse(event, config);
  if (method !== 'POST') {
    return jsonResponse(event, config, err('BAD_REQUEST', 'Method not allowed.'), 405);
  }

  const req = parseHttpBody(event);
  if (isApiErr(req)) return jsonResponse(event, config, req);

  const result = await handler(req, config, { sourceIp: clientIp(event) });
  return jsonResponse(event, config, result);
}
