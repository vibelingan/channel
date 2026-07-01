/**
 * Standard API result envelope shared by cloud functions, the local-server,
 * and the browser admin client. Every backend action returns an `ApiResult`.
 */
import type { ErrorCode } from './errors.ts';

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiErr {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryAfterSeconds?: number;
  };
}

export type ApiResult<T> = ApiOk<T> | ApiErr;

export function ok<T>(data: T): ApiOk<T> {
  return { ok: true, data };
}

export function err(code: ErrorCode, message: string): ApiErr {
  return { ok: false, error: { code, message } };
}

export function rateLimited(message: string, retryAfterSeconds: number): ApiErr {
  return {
    ok: false,
    error: {
      code: 'RATE_LIMITED',
      message,
      retryAfterSeconds,
    },
  };
}

export function isOk<T>(result: ApiResult<T>): result is ApiOk<T> {
  return result.ok === true;
}
