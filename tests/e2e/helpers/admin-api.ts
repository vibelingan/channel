import type { APIRequestContext } from '@playwright/test';
import { e2e } from './env';

export interface SessionUser {
  id: string;
  email: string;
  username: string;
  role: string;
}

export interface AdminSession {
  token: string;
  user: SessionUser;
}

export interface CollectionDoc {
  _id: string;
  [key: string]: unknown;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface ApiSuccess<T> {
  ok: true;
  data: T;
}

interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
  if (!isRecord(value)) return 'Unknown API error';
  const error = value.error;
  if (!isRecord(error)) return 'Unknown API error';
  return typeof error.message === 'string' ? error.message : 'Unknown API error';
}

export async function adminAction<T>(
  request: APIRequestContext,
  action: string,
  data?: unknown,
  token = '',
): Promise<T> {
  const response = await request.post(`${e2e.apiUrl}/api/admin`, {
    data: { action, data, token },
  });
  const json = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok() || !json.ok) {
    throw new Error(`${action} failed (${response.status()}): ${errorMessage(json)}`);
  }
  return json.data;
}

export async function loginAdmin(request: APIRequestContext): Promise<AdminSession> {
  return adminAction<AdminSession>(request, 'login', {
    email: e2e.adminEmail,
    password: e2e.adminPassword,
  });
}

export async function removeIfPresent(
  request: APIRequestContext,
  session: AdminSession,
  collection: string,
  id: string,
): Promise<void> {
  try {
    await adminAction<{ deleted: boolean }>(request, 'remove', { collection, id }, session.token);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('NOT_FOUND') || error.message.includes('Document not found'))
    ) {
      return;
    }
    throw error;
  }
}
