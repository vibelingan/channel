/**
 * HTTP envelope for the alibaba-catalog-sync function (ARCHITECTURE §8.1).
 *
 * Routes (behind the frozen gateway path /api/alibaba-catalog-sync):
 *   OPTIONS *                      -> 204 CORS preflight (admin convention)
 *   GET  .../health                -> release info
 *   GET  .../oauth/callback        -> OAuth callback, 302 back to the site
 *   POST ...                       -> {action, token, data} JSON envelope
 *
 * CORS mirrors the admin adapter: allowed origins from CORS_ALLOWED_ORIGINS;
 * sessions ride the Bearer/JSON body (localStorage — no cookies, no ambient
 * credential on the callback GET).
 */
import { type ApiResult, err } from '@vibelingan-channel/shared';
import { releaseInfo } from '@vibelingan-channel/shared/release';
import {
  type AlibabaSyncFunctionConfig,
  type RequestContext,
  handleAlibabaSyncRequest,
  handleOAuthCallbackRequest,
  type resolveRuntime,
} from './handler.ts';

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

function sourceIp(event: Record<string, unknown>): string | undefined {
  const forwarded = headerValue(event.headers, 'x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const context = event.requestContext;
  if (isRecord(context) && typeof context.sourceIp === 'string' && context.sourceIp) {
    return context.sourceIp;
  }
  return undefined;
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

function corsOrigin(event: Record<string, unknown>, config: AlibabaSyncFunctionConfig): string {
  const origins = config.corsAllowedOrigins ?? [];
  if (origins.length === 0) return '*';
  const origin = headerValue(event.headers, 'origin');
  if (origin && origins.includes(origin)) return origin;
  return origins[0] ?? '*';
}

function responseHeaders(
  event: Record<string, unknown>,
  config: AlibabaSyncFunctionConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function jsonResponse(
  event: Record<string, unknown>,
  config: AlibabaSyncFunctionConfig,
  result: ApiResult<unknown>,
): HttpResponse {
  return {
    statusCode: statusFor(result),
    headers: responseHeaders(event, config, {
      'Content-Type': 'application/json; charset=utf-8',
    }),
    body: JSON.stringify(result),
    isBase64Encoded: false,
  };
}

function queryValue(event: Record<string, unknown>, url: URL, key: string): string | undefined {
  const fromUrl = url.searchParams.get(key);
  if (fromUrl) return fromUrl;
  if (isRecord(event.queryStringParameters)) {
    const value = event.queryStringParameters[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function decodeBody(event: Record<string, unknown>): unknown {
  const raw = event.body;
  if (typeof raw !== 'string' || raw.length === 0) return {};
  const text = event.isBase64Encoded === true ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pathSegments(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  // Strip the gateway prefix (/api/alibaba-catalog-sync/...) wherever it starts.
  const start = segments.indexOf('alibaba-catalog-sync');
  return start >= 0 ? segments.slice(start + 1) : segments;
}

export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export async function handleAlibabaSyncFunctionEvent(
  event: unknown,
  config: AlibabaSyncFunctionConfig,
  runtimeOverrides?: Parameters<typeof resolveRuntime>[1],
): Promise<HttpResponse | ApiResult<unknown>> {
  if (!isHttpEnvelope(event)) {
    // Direct invocation fallback (tests, local callers, future timer events).
    return handleAlibabaSyncRequest(
      (event ?? {}) as Record<string, unknown>,
      config,
      {},
      runtimeOverrides,
    );
  }
  const method = requestMethod(event);
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: responseHeaders(event, config),
      body: '',
      isBase64Encoded: false,
    };
  }

  const url = new URL(requestPath(event), 'https://channel.local');
  const segments = pathSegments(url.pathname);

  if (method === 'GET') {
    if (segments.length === 1 && segments[0] === 'health') {
      return jsonResponse(event, config, {
        ok: true,
        data: releaseInfo('alibaba-catalog-sync'),
      } as ApiResult<unknown>);
    }
    if (segments.length === 2 && segments[0] === 'oauth' && segments[1] === 'callback') {
      // Alibaba's docs show the callback echoing lowercase `state`; accept
      // the capitalized variant too (the request carries both casings).
      const stateValue = queryValue(event, url, 'state') ?? queryValue(event, url, 'State');
      const redirect = await handleOAuthCallbackRequest(
        {
          ...(queryValue(event, url, 'code') !== undefined
            ? { code: queryValue(event, url, 'code') as string }
            : {}),
          ...(stateValue !== undefined ? { state: stateValue } : {}),
        },
        config,
        { ...(sourceIp(event) !== undefined ? { sourceIp: sourceIp(event) as string } : {}) },
        runtimeOverrides,
      );
      return {
        statusCode: 302,
        headers: responseHeaders(event, config, { Location: redirect.location }),
        body: '',
        isBase64Encoded: false,
      };
    }
    return jsonResponse(event, config, err('NOT_FOUND', 'Route not found'));
  }

  if (method === 'POST') {
    const body = decodeBody(event);
    if (body === null || !isRecord(body)) {
      return jsonResponse(event, config, err('BAD_REQUEST', 'Body must be a JSON object.'));
    }
    const context: RequestContext = {
      ...(sourceIp(event) !== undefined ? { sourceIp: sourceIp(event) as string } : {}),
    };
    const result = await handleAlibabaSyncRequest(body, config, context, runtimeOverrides);
    return jsonResponse(event, config, result);
  }

  return {
    statusCode: 405,
    headers: responseHeaders(event, config, {
      'Content-Type': 'application/json; charset=utf-8',
    }),
    body: JSON.stringify(err('BAD_REQUEST', 'Method not allowed.')),
    isBase64Encoded: false,
  };
}
