import { type AdminClaims, signAdminToken, verifyAdminToken } from '@vibelingan-channel/auth/jwt';
/**
 * Adapter-agnostic admin request handler.
 *
 * Both the production cloud function (src/index.ts) and the local-server import
 * `handleAdminRequest`. The only difference between environments is which
 * `DbAdapter` was wired via `@vibelingan-channel/db`'s `setAdapter` before this runs.
 *
 * Protocol — a single POST endpoint receiving:
 *   { action, data, token }
 * and returning an `ApiResult<T>`.
 */
import { verifyPassword } from '@vibelingan-channel/auth/password';
import { UnknownCollectionError, create, get, list, remove, update } from '@vibelingan-channel/db';
import { type ApiResult, COLLECTIONS, err, isKnownCollection, ok } from '@vibelingan-channel/shared';
import { z } from 'zod';

export interface AdminConfig {
  jwtSecret: string;
  /** argon2id hash of the admin password (preferred). */
  adminPasswordHash?: string;
  /** Plaintext admin password (local dev convenience only). */
  adminPasswordPlain?: string;
}

export interface AdminRequest {
  action: string;
  data?: unknown;
  token?: string;
}

const loginSchema = z.object({ password: z.string().min(1) });
const listSchema = z.object({
  collection: z.string(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(20),
  search: z.string().default(''),
});
const idSchema = z.object({ collection: z.string(), id: z.string().min(1) });
const createSchema = z.object({
  collection: z.string(),
  values: z.record(z.unknown()),
});
const updateSchema = z.object({
  collection: z.string(),
  id: z.string().min(1),
  values: z.record(z.unknown()),
});

async function authenticate(req: AdminRequest, config: AdminConfig): Promise<AdminClaims | null> {
  if (!req.token) return null;
  return verifyAdminToken(config.jwtSecret, req.token);
}

async function checkPassword(password: string, config: AdminConfig): Promise<boolean> {
  if (config.adminPasswordHash) {
    return verifyPassword(config.adminPasswordHash, password);
  }
  if (config.adminPasswordPlain) {
    return timingSafeEqual(password, config.adminPasswordPlain);
  }
  return false;
}

export async function handleAdminRequest(
  req: AdminRequest,
  config: AdminConfig,
): Promise<ApiResult<unknown>> {
  try {
    // ---- Public action: login --------------------------------------------
    if (req.action === 'login') {
      const parsed = loginSchema.safeParse(req.data);
      if (!parsed.success) return err('BAD_REQUEST', 'Password is required');
      const valid = await checkPassword(parsed.data.password, config);
      if (!valid) return err('UNAUTHORIZED', 'Invalid password');
      const token = await signAdminToken(config.jwtSecret, { sub: 'admin', role: 'admin' });
      return ok({ token });
    }

    // ---- Everything below requires a valid admin token --------------------
    const claims = await authenticate(req, config);
    if (!claims) return err('UNAUTHORIZED', 'Authentication required');

    switch (req.action) {
      case 'collections':
        return ok({ collections: COLLECTIONS });

      case 'list': {
        const parsed = listSchema.safeParse(req.data);
        if (!parsed.success) return err('BAD_REQUEST', 'Invalid list query');
        if (!isKnownCollection(parsed.data.collection)) {
          return err('UNKNOWN_COLLECTION', `Unknown collection: ${parsed.data.collection}`);
        }
        return ok(await list(parsed.data));
      }

      case 'get': {
        const parsed = idSchema.safeParse(req.data);
        if (!parsed.success) return err('BAD_REQUEST', 'collection and id are required');
        const doc = await get(parsed.data.collection, parsed.data.id);
        if (!doc) return err('NOT_FOUND', 'Document not found');
        return ok(doc);
      }

      case 'create': {
        const parsed = createSchema.safeParse(req.data);
        if (!parsed.success) return err('BAD_REQUEST', 'collection and values are required');
        const doc = await create(parsed.data.collection, parsed.data.values);
        return ok(doc);
      }

      case 'update': {
        const parsed = updateSchema.safeParse(req.data);
        if (!parsed.success) return err('BAD_REQUEST', 'collection, id and values are required');
        const doc = await update(parsed.data.collection, parsed.data.id, parsed.data.values);
        if (!doc) return err('NOT_FOUND', 'Document not found');
        return ok(doc);
      }

      case 'remove': {
        const parsed = idSchema.safeParse(req.data);
        if (!parsed.success) return err('BAD_REQUEST', 'collection and id are required');
        const deleted = await remove(parsed.data.collection, parsed.data.id);
        if (!deleted) return err('NOT_FOUND', 'Document not found');
        return ok({ deleted: true });
      }

      default:
        return err('BAD_REQUEST', `Unknown action: ${req.action}`);
    }
  } catch (e) {
    if (e instanceof UnknownCollectionError) {
      return err('UNKNOWN_COLLECTION', e.message);
    }
    if (e instanceof z.ZodError) {
      return err('VALIDATION_ERROR', e.issues.map((i) => i.message).join('; '));
    }
    console.error('[fn-admin] unexpected error:', e);
    return err('INTERNAL_ERROR', 'Unexpected server error');
  }
}

/** Constant-time string comparison to avoid leaking length/equality timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
