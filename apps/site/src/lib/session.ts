/**
 * Unified client session — the single source of truth for the signed-in user
 * across the storefront, the account page, and the admin dashboard.
 *
 * Stores the session JWT + a minimal user object in localStorage and broadcasts
 * changes via a `channel:auth` event so every island (and inline script) stays
 * in sync. Pure browser module — safe to import from React islands and from
 * Astro `<script>` blocks alike.
 */
import type { Role, SessionUser } from '@vibelingan-channel/shared';
import { canAccessAdmin, canSeeVipPricing } from '@vibelingan-channel/shared';

export type { Role, SessionUser } from '@vibelingan-channel/shared';
export { canAccessAdmin, canManageUsers, canSeeVipPricing } from '@vibelingan-channel/shared';

const TOKEN_KEY = 'channel.token';
const USER_KEY = 'channel.user';
const AUTH_EVENT = 'channel:auth';
const ENDPOINT = '/api/admin';

export interface ApiError {
  code: string;
  message: string;
}

export class SessionApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionApiError';
  }
}

export function getToken(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function getUser(): SessionUser | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: SessionUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export function onAuthChange(handler: () => void): () => void {
  window.addEventListener(AUTH_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(AUTH_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

export function isLoggedIn(): boolean {
  return getToken().length > 0;
}

export function roleOf(user: SessionUser | null): Role {
  return user?.role ?? '';
}

/** Low-level call to the single portal endpoint. Throws SessionApiError. */
export async function callApi<T>(action: string, data?: unknown): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, token: getToken() }),
  });
  if (!res.ok) throw new SessionApiError('INTERNAL_ERROR', `Request failed (${res.status})`);
  const json = (await res.json()) as { ok: true; data: T } | { ok: false; error: ApiError };
  if (!json.ok) {
    if (json.error.code === 'UNAUTHORIZED') clearSession();
    throw new SessionApiError(json.error.code, json.error.message);
  }
  return json.data;
}

interface AuthResult {
  token: string;
  user: SessionUser;
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const { token, user } = await callApi<AuthResult>('login', { email, password });
  setSession(token, user);
  return user;
}

export async function register(
  username: string,
  email: string,
  password: string,
): Promise<SessionUser> {
  const { token, user } = await callApi<AuthResult>('register', { username, email, password });
  setSession(token, user);
  return user;
}

export async function recover(email: string): Promise<string> {
  const { message } = await callApi<{ message: string }>('recover', { email });
  return message;
}

export async function updateProfile(username: string): Promise<SessionUser> {
  const { token, user } = await callApi<AuthResult>('updateProfile', { username });
  setSession(token, user);
  return user;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await callApi<{ message: string }>('changePassword', { currentPassword, newPassword });
}

/** Where a user should land after signing in, based on their role. */
export function postLoginPath(user: SessionUser, returnTo?: string): string {
  if (returnTo?.startsWith('/')) return returnTo;
  if (canAccessAdmin(user.role)) return '/admin';
  return '/';
}

export function userCanSeeVip(): boolean {
  return canSeeVipPricing(roleOf(getUser()));
}
