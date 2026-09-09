import {
  InquiryCapabilitiesSchema,
  InquiryCommandSchema,
  type InquiryData,
} from '@vibelingan-channel/shared/catalog-inquiry';
import { readApiEnvelope } from '../../../lib/api-envelope.ts';
import { apiUrl } from '../../../lib/api-url.ts';
import { getToken } from '../../../lib/session.ts';
import { AdminApiError } from '../api.ts';
import { readInquiryEnvelope } from './inquiry-envelope.ts';

export function isLocalInquiryWorkspace(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  const url = new URL(apiUrl('/api/admin'), window.location.origin);
  return (
    ['127.0.0.1', 'localhost'].includes(window.location.hostname) &&
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.protocol === 'http:' &&
    url.port === '3013'
  );
}
export async function inquiryRequest(input: unknown, signal?: AbortSignal): Promise<InquiryData> {
  const data = InquiryCommandSchema.parse(input);
  const response = await fetch(apiUrl('/api/admin'), {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'inquiry', data, token: getToken() }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const result = await readInquiryEnvelope(response);
  if (!result)
    throw new AdminApiError(
      response.status === 401 ? 'UNAUTHORIZED' : 'INVALID_RESPONSE',
      'No confirmed response. Retry the same change to check its result.',
    );
  if (!result.ok) throw new AdminApiError(result.error.code, result.error.message);
  return result.data;
}
/** UI discovery only. Every inquiry action still rechecks permission and the rollout gate server-side. */
export async function fetchInquiryCapabilities(signal?: AbortSignal) {
  const response = await fetch(apiUrl('/api/admin'), {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'inquiryCapabilities', token: getToken() }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const result = await readApiEnvelope<unknown>(response);
  if (!result || !result.ok)
    throw new AdminApiError(
      !result ? 'INVALID_RESPONSE' : result.error.code,
      'Inquiry capabilities could not be confirmed.',
    );
  const parsed = InquiryCapabilitiesSchema.safeParse(result.data);
  if (!parsed.success) throw new AdminApiError('INVALID_RESPONSE', 'Invalid inquiry capabilities.');
  return parsed.data;
}
export async function listInquiries(page: number, status: string, signal?: AbortSignal) {
  const result = await inquiryRequest(
    { action: 'list', page, pageSize: 20, ...(status ? { status } : {}) },
    signal,
  );
  if (result.kind !== 'list') throw new AdminApiError('INVALID_RESPONSE', 'Expected inquiry list.');
  return result;
}
export async function getInquiry(id: string, signal?: AbortSignal) {
  const result = await inquiryRequest({ action: 'get', id }, signal);
  if (result.kind !== 'detail')
    throw new AdminApiError('INVALID_RESPONSE', 'Expected inquiry detail.');
  return result;
}
export function inquiryTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Hong_Kong',
  }).format(new Date(value));
}
