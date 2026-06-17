/**
 * Adapter-agnostic portal API handler.
 *
 * Both the production cloud function (src/index.ts) and the local-server import
 * `handleAdminRequest`. The only difference between environments is which
 * `DbAdapter` was wired via `@vibelingan-channel/db`'s `setAdapter`.
 *
 * Protocol — a single POST endpoint receiving { action, data, token } and
 * returning an `ApiResult<T>`.
 *
 * Authorization is role-based and embedded in the session JWT, so most actions
 * authorize from the token alone with no extra database round-trip. The
 * trade-off: a role change only takes effect for a user once their current
 * token expires (12h) or they sign in again.
 */
import { type SessionClaims, signSession, verifySession } from '@vibelingan-channel/auth/jwt';
import {
  generateRandomPassword,
  hashPassword,
  verifyPassword,
} from '@vibelingan-channel/auth/password';
import {
  UnknownCollectionError,
  create,
  createDoc,
  findByField,
  get,
  list,
  remove,
  update,
  updateDoc,
} from '@vibelingan-channel/db';
import { sendRecoveryEmail } from '@vibelingan-channel/email';
import {
  type ApiResult,
  COLLECTIONS,
  type CollectionDoc,
  type Role,
  canEditCollection,
  canReadCollection,
  err,
  isKnownCollection,
  ok,
} from '@vibelingan-channel/shared';
import { z } from 'zod';

export interface AdminConfig {
  jwtSecret: string;
  /** Absolute URL of the login page, used in recovery emails. */
  loginUrl?: string;
}

export interface AdminRequest {
  action: string;
  data?: unknown;
  token?: string;
}

// --- Validation schemas ----------------------------------------------------
const registerSchema = z.object({
  username: z.string().min(2).max(40),
  email: z.string().email(),
  password: z.string().min(6).max(200),
});
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const recoverSchema = z.object({ email: z.string().email() });
const updateProfileSchema = z.object({ username: z.string().min(2).max(40) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(200),
});
const listSchema = z.object({
  collection: z.string(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(20),
  search: z.string().default(''),
});
const idSchema = z.object({ collection: z.string(), id: z.string().min(1) });
const createSchema = z.object({ collection: z.string(), values: z.record(z.unknown()) });
const updateSchema = z.object({
  collection: z.string(),
  id: z.string().min(1),
  values: z.record(z.unknown()),
});

const SESSION_TTL = 60 * 60 * 12;

// --- Helpers ---------------------------------------------------------------

/** Minimal, safe representation of a user returned to clients. */
function publicUser(doc: CollectionDoc) {
  return {
    id: doc._id,
    email: doc.email ?? '',
    username: doc.username ?? '',
    role: (doc.role ?? '') as Role,
    status: doc.status ?? 'active',
  };
}

/** Redact sensitive fields from documents returned for the `users` collection. */
function redact(collection: string, doc: CollectionDoc): CollectionDoc {
  if (collection !== 'users') return doc;
  const { passwordHash: _omit, ...rest } = doc as Record<string, unknown> & {
    passwordHash?: string;
  };
  return rest as CollectionDoc;
}

function authenticate(req: AdminRequest, config: AdminConfig): Promise<SessionClaims | null> {
  if (!req.token) return Promise.resolve(null);
  return verifySession(config.jwtSecret, req.token);
}

function issueToken(config: AdminConfig, doc: CollectionDoc): Promise<string> {
  return signSession(
    config.jwtSecret,
    {
      sub: doc._id,
      email: String(doc.email ?? ''),
      name: String(doc.username ?? ''),
      role: (doc.role ?? '') as Role,
    },
    SESSION_TTL,
  );
}

// --- Handler ---------------------------------------------------------------

export async function handleAdminRequest(
  req: AdminRequest,
  config: AdminConfig,
): Promise<ApiResult<unknown>> {
  try {
    // ---- Public auth actions ------------------------------------------
    switch (req.action) {
      case 'register':
        return await register(req, config);
      case 'login':
        return await login(req, config);
      case 'recover':
        return await recover(req, config);
    }

    // ---- Everything below requires a valid session --------------------
    const claims = await authenticate(req, config);
    if (!claims) return err('UNAUTHORIZED', 'Authentication required');

    switch (req.action) {
      case 'me':
        return await me(claims);
      case 'updateProfile':
        return await updateProfile(req, claims, config);
      case 'changePassword':
        return await changePassword(req, claims);
      case 'collections':
        return ok({ collections: COLLECTIONS });
      case 'list':
        return await listAction(req, claims);
      case 'get':
        return await getAction(req, claims);
      case 'create':
        return await createAction(req, claims);
      case 'update':
        return await updateAction(req, claims);
      case 'remove':
        return await removeAction(req, claims);
      default:
        return err('BAD_REQUEST', `Unknown action: ${req.action}`);
    }
  } catch (e) {
    if (e instanceof UnknownCollectionError) return err('UNKNOWN_COLLECTION', e.message);
    if (e instanceof z.ZodError) {
      return err('VALIDATION_ERROR', e.issues.map((i) => i.message).join('; '));
    }
    console.error('[fn-admin] unexpected error:', e);
    return err('INTERNAL_ERROR', 'Unexpected server error');
  }
}

// --- Auth actions ----------------------------------------------------------

async function register(req: AdminRequest, config: AdminConfig): Promise<ApiResult<unknown>> {
  const parsed = registerSchema.safeParse(req.data);
  if (!parsed.success) {
    return err('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const email = parsed.data.email.toLowerCase();
  if (await findByField('users', 'email', email)) {
    return err('CONFLICT', 'An account with this email already exists.');
  }
  if (await findByField('users', 'username', parsed.data.username)) {
    return err('CONFLICT', 'This username is taken.');
  }
  const passwordHash = await hashPassword(parsed.data.password);
  // New users get the blank base role; admins assign roles later.
  const doc = await createDoc('users', {
    username: parsed.data.username,
    email,
    role: '',
    status: 'active',
    passwordHash,
    loginCount: 0,
  });
  const token = await issueToken(config, doc);
  return ok({ token, user: publicUser(doc) });
}

async function login(req: AdminRequest, config: AdminConfig): Promise<ApiResult<unknown>> {
  const parsed = loginSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'Email and password are required.');
  const email = parsed.data.email.toLowerCase();
  const user = await findByField('users', 'email', email);
  const hash = typeof user?.passwordHash === 'string' ? user.passwordHash : '';
  const valid = hash ? await verifyPassword(hash, parsed.data.password) : false;
  if (!user || !valid) return err('UNAUTHORIZED', 'Invalid email or password.');
  if (user.status === 'suspended') return err('FORBIDDEN', 'This account is suspended.');

  // Record login (fire-and-forget; never blocks the response).
  updateDoc('users', user._id, {
    lastLoginAt: new Date().toISOString(),
    loginCount: Number(user.loginCount ?? 0) + 1,
  }).catch((e) => console.error('[login] recordLogin failed:', e));

  const token = await issueToken(config, user);
  return ok({ token, user: publicUser(user) });
}

async function recover(req: AdminRequest, config: AdminConfig): Promise<ApiResult<unknown>> {
  const parsed = recoverSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'A valid email is required.');
  const email = parsed.data.email.toLowerCase();
  const user = await findByField('users', 'email', email);
  if (user) {
    const newPassword = generateRandomPassword(12);
    const passwordHash = await hashPassword(newPassword);
    await updateDoc('users', user._id, { passwordHash });
    await sendRecoveryEmail({
      to: email,
      username: String(user.username ?? ''),
      newPassword,
      loginUrl: config.loginUrl ?? 'http://localhost:4321/login',
    });
  }
  // Always return the same response so the endpoint cannot probe which emails
  // are registered.
  return ok({ message: 'If that email is registered, a new password has been sent.' });
}

// --- Authenticated profile actions ----------------------------------------

async function me(claims: SessionClaims): Promise<ApiResult<unknown>> {
  const user = await get('users', claims.sub);
  if (!user) return err('NOT_FOUND', 'Account not found.');
  return ok({ user: publicUser(user) });
}

async function updateProfile(
  req: AdminRequest,
  claims: SessionClaims,
  config: AdminConfig,
): Promise<ApiResult<unknown>> {
  const parsed = updateProfileSchema.safeParse(req.data);
  if (!parsed.success) return err('VALIDATION_ERROR', 'A valid username is required.');
  const existing = await findByField('users', 'username', parsed.data.username);
  if (existing && existing._id !== claims.sub) return err('CONFLICT', 'This username is taken.');
  const updated = await updateDoc('users', claims.sub, { username: parsed.data.username });
  if (!updated) return err('NOT_FOUND', 'Account not found.');
  // Re-issue the token so the new username is reflected in the session.
  const token = await issueToken(config, updated);
  return ok({ token, user: publicUser(updated) });
}

async function changePassword(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  const parsed = changePasswordSchema.safeParse(req.data);
  if (!parsed.success) {
    return err('VALIDATION_ERROR', 'Current and new password (min 6 chars) are required.');
  }
  const user = await get('users', claims.sub);
  if (!user) return err('NOT_FOUND', 'Account not found.');
  const hash = typeof user.passwordHash === 'string' ? user.passwordHash : '';
  if (!hash || !(await verifyPassword(hash, parsed.data.currentPassword))) {
    return err('UNAUTHORIZED', 'Current password is incorrect.');
  }
  await updateDoc('users', claims.sub, {
    passwordHash: await hashPassword(parsed.data.newPassword),
  });
  return ok({ message: 'Password updated.' });
}

// --- Collection CRUD (role-gated) ------------------------------------------

function ensureKnown(collection: string): ApiResult<never> | null {
  if (!isKnownCollection(collection)) {
    return err('UNKNOWN_COLLECTION', `Unknown collection: ${collection}`);
  }
  return null;
}

async function listAction(req: AdminRequest, claims: SessionClaims): Promise<ApiResult<unknown>> {
  const parsed = listSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'Invalid list query');
  const unknown = ensureKnown(parsed.data.collection);
  if (unknown) return unknown;
  if (!canReadCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have access to this collection.');
  }
  const result = await list(parsed.data);
  return ok({ ...result, items: result.items.map((d) => redact(parsed.data.collection, d)) });
}

async function getAction(req: AdminRequest, claims: SessionClaims): Promise<ApiResult<unknown>> {
  const parsed = idSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'collection and id are required');
  if (!canReadCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have access to this collection.');
  }
  const doc = await get(parsed.data.collection, parsed.data.id);
  if (!doc) return err('NOT_FOUND', 'Document not found');
  return ok(redact(parsed.data.collection, doc));
}

async function createAction(req: AdminRequest, claims: SessionClaims): Promise<ApiResult<unknown>> {
  const parsed = createSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'collection and values are required');
  if (!canEditCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have permission to modify this collection.');
  }
  const doc = await create(parsed.data.collection, parsed.data.values);
  return ok(redact(parsed.data.collection, doc));
}

async function updateAction(req: AdminRequest, claims: SessionClaims): Promise<ApiResult<unknown>> {
  const parsed = updateSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'collection, id and values are required');
  if (!canEditCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have permission to modify this collection.');
  }
  const doc = await update(parsed.data.collection, parsed.data.id, parsed.data.values);
  if (!doc) return err('NOT_FOUND', 'Document not found');
  return ok(redact(parsed.data.collection, doc));
}

async function removeAction(req: AdminRequest, claims: SessionClaims): Promise<ApiResult<unknown>> {
  const parsed = idSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'collection and id are required');
  if (!canEditCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have permission to modify this collection.');
  }
  const deleted = await remove(parsed.data.collection, parsed.data.id);
  if (!deleted) return err('NOT_FOUND', 'Document not found');
  return ok({ deleted: true });
}
