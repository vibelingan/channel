import { type ApiResult, err, ok } from '@vibelingan-channel/shared';
import {
  type BinaryResult,
  type CatalogQuery,
  type PublicApiConfig,
  getCatalogImage,
  getCatalogItem,
  listCatalog,
  parseCatalogName,
} from './handler.ts';

export interface PublicHttpConfig extends PublicApiConfig {
  corsAllowedOrigins?: readonly string[];
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

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
  return 'GET';
}

function requestPath(event: Record<string, unknown>): string {
  const direct = event.path ?? event.rawPath;
  if (typeof direct === 'string' && direct) return direct;
  const context = event.requestContext;
  if (isRecord(context)) {
    if (typeof context.path === 'string' && context.path) return context.path;
    const http = context.http;
    if (isRecord(http) && typeof http.path === 'string' && http.path) return http.path;
  }
  return '/';
}

function requestOrigin(event: Record<string, unknown>): string {
  return headerValue(event.headers, 'origin');
}

function isHttpEnvelope(event: unknown): event is Record<string, unknown> {
  if (!isRecord(event)) return false;
  return (
    hasKey(event, 'path') ||
    hasKey(event, 'rawPath') ||
    hasKey(event, 'headers') ||
    hasKey(event, 'httpMethod') ||
    hasKey(event, 'method') ||
    hasKey(event, 'queryStringParameters') ||
    hasKey(event, 'requestContext')
  );
}

function corsOrigin(event: Record<string, unknown>, config: PublicHttpConfig): string {
  const origins = config.corsAllowedOrigins ?? [];
  if (origins.length === 0) return '*';
  const origin = requestOrigin(event);
  if (origin && origins.includes(origin)) return origin;
  return origins[0] ?? '*';
}

function responseHeaders(
  event: Record<string, unknown>,
  config: PublicHttpConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Origin': corsOrigin(event, config),
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra,
  };
}

function statusFor(result: ApiResult<unknown>): number {
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
    case 'INTERNAL_ERROR':
      return 500;
    default: {
      const _exhaustive: never = result.error.code;
      throw new Error(`Unhandled error code: ${_exhaustive}`);
    }
  }
}

function jsonResponse(
  event: Record<string, unknown>,
  config: PublicHttpConfig,
  result: ApiResult<unknown>,
  statusCode = statusFor(result),
): HttpResponse {
  return {
    statusCode,
    headers: responseHeaders(event, config, {
      'Content-Type': 'application/json; charset=utf-8',
    }),
    body: JSON.stringify(result),
    isBase64Encoded: false,
  };
}

function binaryResponse(
  event: Record<string, unknown>,
  config: PublicHttpConfig,
  result: BinaryResult,
): HttpResponse {
  return {
    statusCode: 200,
    headers: responseHeaders(event, config, result.headers),
    body: result.body,
    isBase64Encoded: true,
  };
}

function optionsResponse(event: Record<string, unknown>, config: PublicHttpConfig): HttpResponse {
  return {
    statusCode: 204,
    headers: responseHeaders(event, config),
    body: '',
    isBase64Encoded: false,
  };
}

function firstQueryValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((v): v is string => typeof v === 'string');
    return first ?? '';
  }
  return '';
}

function queryParams(event: Record<string, unknown>, url: URL): URLSearchParams {
  const params = new URLSearchParams(url.searchParams);
  if (isRecord(event.queryStringParameters)) {
    for (const [key, value] of Object.entries(event.queryStringParameters)) {
      const text = firstQueryValue(value);
      if (text) params.set(key, text);
    }
  }
  return params;
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function catalogQuery(params: URLSearchParams): CatalogQuery {
  const category = params.get('category')?.trim();
  const categories = category
    ? category
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : [];
  return {
    ...(categories.length > 0 ? { categories } : {}),
    search: params.get('search') ?? '',
    page: parsePositiveInt(params.get('page') ?? '', 1),
    pageSize: parsePositiveInt(params.get('pageSize') ?? '', 24),
  };
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function routeGet(
  event: Record<string, unknown>,
  config: PublicHttpConfig,
): Promise<HttpResponse> {
  const url = new URL(requestPath(event), 'https://channel.local');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const params = queryParams(event, url);
  const segments = path.split('/').filter(Boolean);

  if (path === '/api/health') {
    return jsonResponse(event, config, ok({ status: 'ok', service: 'public-api' }));
  }

  if (segments[0] !== 'api') {
    return jsonResponse(event, config, err('NOT_FOUND', 'Route not found'));
  }

  const collection = segments[1] ? parseCatalogName(segments[1]) : null;
  if (collection && segments.length === 2) {
    return jsonResponse(event, config, await listCatalog(collection, catalogQuery(params), config));
  }

  if (collection && segments.length === 3) {
    return jsonResponse(
      event,
      config,
      await getCatalogItem(collection, decodeSegment(segments[2] ?? ''), config),
    );
  }

  if (segments[1] === 'images' && segments.length === 3) {
    const result = await getCatalogImage(decodeSegment(segments[2] ?? ''));
    return result.ok && 'isBase64Encoded' in result
      ? binaryResponse(event, config, result)
      : jsonResponse(event, config, result);
  }

  return jsonResponse(event, config, err('NOT_FOUND', 'Route not found'));
}

export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export async function handlePublicApiEvent(
  event: unknown,
  config: PublicHttpConfig,
): Promise<HttpResponse> {
  const envelope = isHttpEnvelope(event) ? event : { path: '/api/health', httpMethod: 'GET' };
  const method = requestMethod(envelope);
  if (method === 'OPTIONS') return optionsResponse(envelope, config);
  if (method !== 'GET') {
    return jsonResponse(envelope, config, err('BAD_REQUEST', 'Method not allowed.'), 405);
  }
  return routeGet(envelope, config);
}
