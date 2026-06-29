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
import { timingSafeEqual } from 'node:crypto';
import { type SessionClaims, signSession, verifySession } from '@vibelingan-channel/auth/jwt';
import {
  generateRandomPassword,
  hashPassword,
  verifyPassword,
} from '@vibelingan-channel/auth/password';
import {
  UnknownCollectionError,
  batchRemove,
  batchUpdate,
  create,
  createDoc,
  findByField,
  get,
  incrementField,
  list,
  remove,
  update,
  updateDoc,
} from '@vibelingan-channel/db';
import { sendOemConfirmationEmail, sendRecoveryEmail } from '@vibelingan-channel/email';
import {
  type ApiResult,
  COLLECTIONS,
  type CollectionDoc,
  FILTER_OPERATORS,
  type Role,
  canEditCollection,
  canReadCollection,
  err,
  getCollection,
  isKnownCollection,
  ok,
} from '@vibelingan-channel/shared';
import { z } from 'zod';

export interface AdminConfig {
  jwtSecret: string;
  /** Absolute URL of the login page, used in recovery emails. */
  loginUrl?: string;
  bootstrap?: {
    enabled: boolean;
    adminToken?: string;
    adminEmail?: string;
    adminPasswordHash?: string;
  };
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
const bootstrapAdminSchema = z.object({ token: z.string().min(1).max(4096) });
const recoverSchema = z.object({ email: z.string().email() });
const submitProjectSchema = z.object({
  company: z.string().min(1).max(200),
  contact: z.string().min(1).max(200),
  email: z.string().email(),
  whatsapp: z.string().max(60).optional(),
  category: z.string().max(100).optional(),
  quantity: z.union([z.string(), z.number()]).optional(),
  drawingName: z.string().max(300).optional(),
  drawingType: z.string().max(200).optional(),
  // Base64-encoded file bytes (~12MB cap, matching the server body limit).
  drawingData: z.string().max(16_000_000).optional(),
});
const updateProfileSchema = z.object({ username: z.string().min(2).max(40) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(200),
});
const filterClauseSchema = z.object({
  field: z.string().min(1),
  op: z.enum(FILTER_OPERATORS),
  value: z.unknown().optional(),
});
const filterModelSchema = z.object({
  combinator: z.enum(['and', 'or']).default('and'),
  clauses: z.array(filterClauseSchema).default([]),
});
const sortClauseSchema = z.object({
  field: z.string().min(1),
  dir: z.enum(['asc', 'desc']),
});
const listSchema = z.object({
  collection: z.string(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(20),
  search: z.string().default(''),
  filter: filterModelSchema.optional(),
  sort: z.array(sortClauseSchema).optional(),
});
const idSchema = z.object({ collection: z.string(), id: z.string().min(1) });
const createSchema = z.object({ collection: z.string(), values: z.record(z.unknown()) });
const updateSchema = z.object({
  collection: z.string(),
  id: z.string().min(1),
  values: z.record(z.unknown()),
});
const batchUpdateSchema = z.object({
  collection: z.string(),
  ids: z.array(z.string().min(1)).min(1).max(500),
  values: z.record(z.unknown()),
});
const batchRemoveSchema = z.object({
  collection: z.string(),
  ids: z.array(z.string().min(1)).min(1).max(500),
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

function timingSafeStringEqual(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  if (right.length === 0) return false;

  if (left.length !== right.length) {
    const length = Math.max(left.length, right.length, 1);
    const paddedLeft = Buffer.alloc(length);
    const paddedRight = Buffer.alloc(length);
    left.copy(paddedLeft);
    right.copy(paddedRight);
    timingSafeEqual(paddedLeft, paddedRight);
    return false;
  }

  return timingSafeEqual(left, right);
}

interface ReadyBootstrapConfig {
  adminToken: string;
  adminEmail: string;
  adminPasswordHash: string;
}

function readyBootstrapConfig(config: AdminConfig): ReadyBootstrapConfig | null {
  const bootstrap = config.bootstrap;
  if (!bootstrap?.enabled) return null;

  const adminToken = bootstrap.adminToken?.trim() ?? '';
  const adminEmail = bootstrap.adminEmail?.trim().toLowerCase() ?? '';
  const adminPasswordHash = bootstrap.adminPasswordHash?.trim() ?? '';
  if (!adminToken || !adminEmail || !adminPasswordHash) return null;
  if (!z.string().email().safeParse(adminEmail).success) return null;
  return { adminToken, adminEmail, adminPasswordHash };
}

function bootstrapUsername(email: string): string {
  const [localPart = ''] = email.split('@');
  const normalized = localPart.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);
  return normalized.length >= 2 ? normalized : 'admin';
}

async function activeAdminExists(): Promise<boolean> {
  const admins = await list({
    collection: 'users',
    page: 1,
    pageSize: 1,
    filter: {
      combinator: 'and',
      clauses: [
        { field: 'role', op: 'eq', value: 'admin' },
        { field: 'status', op: 'eq', value: 'active' },
      ],
    },
  });
  return admins.total > 0;
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
      case 'bootstrapAdmin':
        return await bootstrapAdmin(req, config);
      case 'recover':
        return await recover(req, config);
      case 'submitProject':
        return await submitProject(req);
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
      case 'batchUpdate':
        return await batchUpdateAction(req, claims);
      case 'batchRemove':
        return await batchRemoveAction(req, claims);
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

async function bootstrapAdmin(req: AdminRequest, config: AdminConfig): Promise<ApiResult<unknown>> {
  const settings = readyBootstrapConfig(config);
  if (!settings) return err('FORBIDDEN', 'Bootstrap is not available.');

  const parsed = bootstrapAdminSchema.safeParse(req.data);
  const suppliedToken = parsed.success ? parsed.data.token : '';
  if (!timingSafeStringEqual(suppliedToken, settings.adminToken)) {
    return err('UNAUTHORIZED', 'Invalid bootstrap request.');
  }

  if (await activeAdminExists()) {
    return err('CONFLICT', 'An active admin account already exists.');
  }

  if (await findByField('users', 'email', settings.adminEmail)) {
    return err('CONFLICT', 'Bootstrap admin email already exists.');
  }

  const username = bootstrapUsername(settings.adminEmail);
  if (await findByField('users', 'username', username)) {
    return err('CONFLICT', 'Bootstrap admin username already exists.');
  }

  const doc = await createDoc('users', {
    email: settings.adminEmail,
    username,
    role: 'admin',
    status: 'active',
    passwordHash: settings.adminPasswordHash,
    loginCount: 0,
  });

  return ok({
    user: publicUser(doc),
    bootstrap: { disableRequired: true },
  });
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

/**
 * Public OEM project enquiry. Anyone may submit; the request is persisted to the
 * `oemProjects` collection (visible to admins/contributors in the dashboard) and
 * the submitter receives a confirmation email with the new reference id.
 */
async function submitProject(req: AdminRequest): Promise<ApiResult<unknown>> {
  const parsed = submitProjectSchema.safeParse(req.data);
  if (!parsed.success) {
    return err('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const {
    company,
    contact,
    email,
    whatsapp,
    category,
    quantity,
    drawingName,
    drawingType,
    drawingData,
  } = parsed.data;
  const numericQuantity = quantity === undefined || quantity === '' ? undefined : Number(quantity);

  // Persist the uploaded drawing as a standalone byte document (like images),
  // and reference it by id from the project. The bytes never live inline.
  let drawingId = '';
  if (drawingData) {
    const fileDoc = await createDoc('files', {
      name: drawingName ?? 'drawing',
      mimeType: drawingType ?? 'application/octet-stream',
      data: drawingData,
    });
    drawingId = fileDoc._id;
  }

  const doc = await createDoc('oemProjects', {
    company,
    contact,
    email: email.toLowerCase(),
    whatsapp: whatsapp ?? '',
    category: category ?? '',
    ...(numericQuantity !== undefined && !Number.isNaN(numericQuantity)
      ? { quantity: numericQuantity }
      : {}),
    drawingName: drawingName ?? '',
    drawing: drawingId,
    status: 'new',
  });

  // Best-effort acknowledgement; never block the submission on email delivery.
  await sendOemConfirmationEmail({
    to: email.toLowerCase(),
    contact,
    company,
    category: category ?? '',
    projectId: doc._id,
  }).catch((e) => console.error('[submitProject] confirmation email failed:', e));

  return ok({ id: doc._id });
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
  const { filter, sort, ...rest } = parsed.data;
  const result = await list({
    ...rest,
    ...(filter ? { filter } : {}),
    ...(sort ? { sort } : {}),
  });
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

/**
 * Catalog collections (products, overstock) reference images by id and carry a
 * `published` flag; only they affect public image visibility. Gating on the
 * presence of an `imageIds` field means non-catalog mutations skip the extra
 * before-state read entirely.
 */
function tracksImageVisibility(collection: string): boolean {
  const def = getCollection(collection);
  return def?.fields.some((field) => field.name === 'imageIds') ?? false;
}

/**
 * The image ids a catalog document makes PUBLIC: only when it is `published`
 * with an `imageIds` array. An unpublished (or non-catalog) document
 * contributes nothing. Duplicate ids within one document collapse to a single
 * reference.
 */
function publishedImageIdSet(doc: CollectionDoc | null): Set<string> {
  if (!doc || doc.published !== true || !Array.isArray(doc.imageIds)) return new Set();
  return new Set(doc.imageIds.map((id) => String(id)).filter((id) => id.length > 0));
}

/**
 * Maintain `images.publishedRefCount` for the before → after transition of one
 * catalog document: +1 for each image newly made public, −1 for each no longer
 * public. `publishedRefCount` is the canonical public-visibility gate (MIU-04,
 * design §20.6). `incrementField` is a no-op (returns null) for a dangling
 * image id, so a reference to a since-deleted image is harmless.
 *
 * This runs AFTER the catalog write has committed and is not transactional with
 * it. Two consequences, both reconciled by the Phase-D backfill (design §20.6
 * step 5), not prevented here:
 *  - Per-image failures are isolated: a single image's counter error (e.g. a
 *    corrupted non-numeric counter) is logged and skipped so it cannot strand
 *    its siblings or mask an already-committed write as a 500. The disjoint
 *    new/old loops never touch the same id within one call.
 *  - Concurrent mutations of the same document can still race (the before-read
 *    and the increment are separate steps); atomic increments keep each write
 *    consistent but cannot un-stale a delta computed from an older snapshot.
 */
async function applyImageVisibilityDelta(
  before: CollectionDoc | null,
  after: CollectionDoc | null,
): Promise<void> {
  const oldIds = publishedImageIdSet(before);
  const newIds = publishedImageIdSet(after);
  const adjust = async (imageId: string, delta: number): Promise<void> => {
    try {
      await incrementField('images', imageId, 'publishedRefCount', delta);
    } catch (e) {
      console.error(
        `[fn-admin] publishedRefCount ${delta > 0 ? '+' : ''}${delta} failed for image ${imageId} (backfill will reconcile):`,
        e,
      );
    }
  };
  for (const id of newIds) {
    if (!oldIds.has(id)) await adjust(id, 1);
  }
  for (const id of oldIds) {
    if (!newIds.has(id)) await adjust(id, -1);
  }
}

async function createAction(req: AdminRequest, claims: SessionClaims): Promise<ApiResult<unknown>> {
  const parsed = createSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'collection and values are required');
  if (!canEditCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have permission to modify this collection.');
  }
  const doc = await create(parsed.data.collection, parsed.data.values);
  if (tracksImageVisibility(parsed.data.collection)) {
    await applyImageVisibilityDelta(null, doc);
  }
  return ok(redact(parsed.data.collection, doc));
}

async function updateAction(req: AdminRequest, claims: SessionClaims): Promise<ApiResult<unknown>> {
  const parsed = updateSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'collection, id and values are required');
  if (!canEditCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have permission to modify this collection.');
  }
  const tracks = tracksImageVisibility(parsed.data.collection);
  const before = tracks ? await get(parsed.data.collection, parsed.data.id) : null;
  const doc = await update(parsed.data.collection, parsed.data.id, parsed.data.values);
  if (!doc) return err('NOT_FOUND', 'Document not found');
  if (tracks) await applyImageVisibilityDelta(before, doc);
  return ok(redact(parsed.data.collection, doc));
}

async function removeAction(req: AdminRequest, claims: SessionClaims): Promise<ApiResult<unknown>> {
  const parsed = idSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'collection and id are required');
  if (!canEditCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have permission to modify this collection.');
  }
  const tracks = tracksImageVisibility(parsed.data.collection);
  const before = tracks ? await get(parsed.data.collection, parsed.data.id) : null;
  const deleted = await remove(parsed.data.collection, parsed.data.id);
  if (!deleted) return err('NOT_FOUND', 'Document not found');
  if (tracks) await applyImageVisibilityDelta(before, null);
  return ok({ deleted: true });
}

async function batchUpdateAction(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  const parsed = batchUpdateSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'collection, ids and values are required');
  const unknown = ensureKnown(parsed.data.collection);
  if (unknown) return unknown;
  if (!canEditCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have permission to modify this collection.');
  }
  const tracks = tracksImageVisibility(parsed.data.collection);
  // Capture before-states once per unique id (a duplicate id must not double
  // count the visibility delta).
  const befores = tracks
    ? new Map(
        await Promise.all(
          [...new Set(parsed.data.ids)].map(
            async (id) => [id, await get(parsed.data.collection, id)] as const,
          ),
        ),
      )
    : null;
  const docs = await batchUpdate(parsed.data.collection, parsed.data.ids, parsed.data.values);
  if (befores) {
    const applied = new Set<string>();
    for (const after of docs) {
      const id = String(after._id);
      if (applied.has(id)) continue;
      applied.add(id);
      await applyImageVisibilityDelta(befores.get(id) ?? null, after);
    }
  }
  return ok({ updated: docs.length, items: docs.map((d) => redact(parsed.data.collection, d)) });
}

async function batchRemoveAction(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  const parsed = batchRemoveSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'collection and ids are required');
  const unknown = ensureKnown(parsed.data.collection);
  if (unknown) return unknown;
  if (!canEditCollection(claims.role, parsed.data.collection)) {
    return err('FORBIDDEN', 'You do not have permission to modify this collection.');
  }
  const tracks = tracksImageVisibility(parsed.data.collection);
  // Capture before-states per unique id, then decrement only for ids this call
  // actually removed (batchRemove returns the removed ids, each at most once) —
  // mirroring batchUpdate's iterate-over-results invariant so a concurrent
  // delete of the same doc cannot trigger a double-decrement here.
  const befores = tracks
    ? new Map(
        await Promise.all(
          [...new Set(parsed.data.ids)].map(
            async (id) => [id, await get(parsed.data.collection, id)] as const,
          ),
        ),
      )
    : null;
  const removedIds = await batchRemove(parsed.data.collection, parsed.data.ids);
  if (befores) {
    for (const id of removedIds) {
      await applyImageVisibilityDelta(befores.get(id) ?? null, null);
    }
  }
  return ok({ removed: removedIds.length });
}
