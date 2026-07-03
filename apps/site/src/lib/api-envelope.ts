import { type ApiResult, ERROR_CODES, type ErrorCode } from '@vibelingan-channel/shared';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.includes(value as ErrorCode);
}

function isApiResult<T>(value: unknown): value is ApiResult<T> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (value.ok === true) return 'data' in value;
  const error = value.error;
  if (!isRecord(error) || !isErrorCode(error.code) || typeof error.message !== 'string') {
    return false;
  }
  return error.retryAfterSeconds === undefined || typeof error.retryAfterSeconds === 'number';
}

export async function readApiEnvelope<T>(res: Response): Promise<ApiResult<T> | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isApiResult<T>(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
