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
import { Buffer } from 'node:buffer';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { type SessionClaims, signSession, verifySession } from '@vibelingan-channel/auth/jwt';
import {
  generateRandomPassword,
  hashPassword,
  verifyPassword,
} from '@vibelingan-channel/auth/password';
import {
  UnknownCollectionError,
  backfillPublishedRefCounts,
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
  type StoredMediaObject,
  catalogStoragePath,
  mediaStorage,
  objectStoragePath,
} from '@vibelingan-channel/media-storage';
import {
  type ApiResult,
  CATALOG_IMAGE_MAX_BYTES,
  COLLECTIONS,
  type CollectionDoc,
  FILTER_OPERATORS,
  type FilterClause,
  type MediaSignature,
  type MediaStatus,
  OEM_DOWNLOAD_URL_TTL_SECONDS,
  OEM_FILE_MAX_BYTES,
  OEM_MAX_PENDING_INTENTS_GLOBAL,
  OEM_MAX_PENDING_INTENTS_PER_SOURCE,
  OEM_UPLOAD_INTENT_TTL_MS,
  OEM_UPLOAD_RATE_MAX_PER_WINDOW,
  OEM_UPLOAD_RATE_MAX_PER_WINDOW_GLOBAL,
  OEM_UPLOAD_RATE_WINDOW_MS,
  type Role,
  SIGNATURE_MIME,
  canEditCollection,
  canReadCollection,
  catalogImageUploadSchema,
  err,
  evaluateFixedWindowRateLimit,
  fileExtension,
  getCollection,
  isKnownCollection,
  oemFileUploadSchema,
  ok,
  rateLimited,
  sanitizeDownloadFilename,
  selectExpiredPendingForSweep,
  signatureMatchesMime,
  sniffMagicBytes,
  toRole,
  withinPendingCap,
} from '@vibelingan-channel/shared';
import { releaseInfo } from '@vibelingan-channel/shared/release';
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

/**
 * Per-request context the transport (HTTP adapter) derives from the raw event
 * and the pure handler cannot see from `{action,data,token}` alone. Optional so
 * direct/local callers and existing tests keep working unchanged.
 */
export interface RequestContext {
  /** Best-effort client IP (first `x-forwarded-for` hop / gateway sourceIp). */
  sourceIp?: string;
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
  // Storage-upload finalization (MIU-08 §20.10): the browser POSTs bytes to COS
  // with a `createOemFileUploadIntent` credential, then references the pending
  // `files` row here. All three are required TOGETHER (a partial triad is rejected).
  drawingFileId: z.string().min(1).max(200).optional(),
  uploadIntentId: z.string().min(1).max(200).optional(),
  uploadSecret: z.string().min(1).max(400).optional(),
  // Legacy base64 fallback (inline `data`); superseded by the storage path above.
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

const completeUploadSchema = z.object({
  imageId: z.string().min(1),
});

const imagePreviewSchema = z.object({ id: z.string().min(1) });

const oemFileDownloadSchema = z.object({ fileId: z.string().min(1) });

const SESSION_TTL = 60 * 60 * 12;

// --- Helpers ---------------------------------------------------------------

/** Minimal, safe representation of a user returned to clients. */
function publicUser(doc: CollectionDoc) {
  return {
    id: doc._id,
    email: doc.email ?? '',
    username: doc.username ?? '',
    role: toRole(doc.role),
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

/**
 * Re-anchor a verified token to the CURRENT users row (V3: revocation). The
 * JWT proves identity for its 12h TTL, but authorization must reflect the row
 * as it exists NOW: a deleted or suspended user loses access on their next
 * request, and a demoted (or promoted) user drops/gains their current role
 * immediately. Suspension mirrors `login` (only an explicit
 * `status: 'suspended'` revokes — legacy rows without a status stay valid);
 * a missing row means the account was removed, so the session dies with it.
 * One `get` per authenticated request buys revocation without a
 * token-generation scheme; every action below authorizes against the
 * RETURNED claims' role, so this single choke point covers them all.
 */
async function revalidateSession(claims: SessionClaims): Promise<SessionClaims | null> {
  const user = await get('users', claims.sub);
  if (!user) return null;
  if (user.status === 'suspended') return null;
  return { ...claims, role: toRole(user.role) };
}

function issueToken(config: AdminConfig, doc: CollectionDoc): Promise<string> {
  return signSession(
    config.jwtSecret,
    {
      sub: doc._id,
      email: String(doc.email ?? ''),
      name: String(doc.username ?? ''),
      role: toRole(doc.role),
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
  context?: RequestContext,
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
      case 'health':
        return ok(releaseInfo('admin'));
      case 'submitProject':
        return await submitProject(req);
      case 'createOemFileUploadIntent':
        return await createOemFileUploadIntentAction(req, context);
    }

    // ---- Everything below requires a valid session --------------------
    const tokenClaims = await authenticate(req, config);
    if (!tokenClaims) return err('UNAUTHORIZED', 'Authentication required');
    // V3: the token proves identity; the LIVE users row decides authorization.
    const claims = await revalidateSession(tokenClaims);
    if (!claims) return err('UNAUTHORIZED', 'This session is no longer valid.');

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
      case 'backfillImageRefCounts':
        return await backfillImageRefCountsAction(req, claims);
      case 'cleanupOrphanImages':
        return await cleanupOrphanImagesAction(req, claims);
      case 'migrateLegacyImages':
        return await migrateLegacyImagesAction(req, claims);
      case 'createUploadIntent':
        return await createUploadIntentAction(req, claims);
      case 'completeUpload':
        return await completeUploadAction(req, claims);
      case 'getImagePreview':
        return await getImagePreviewAction(req, claims);
      case 'getOemFileDownloadUrl':
        return await getOemFileDownloadUrlAction(req, claims);
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
 * True iff SERVER-fetched `bytes` are consistent with the file's declared type.
 * Types with a reliable magic number (pdf/zip/rar/png/jpg/webp) must match their
 * bytes; CAD formats (step/stp/igs/iges/dwg/dxf) have no universal signature and
 * are extension-gated — but a CAD-extension file whose bytes sniff as some OTHER
 * known type is rejected (blocks disguising a real payload behind a CAD name).
 */
function oemBytesMatchType(fileName: string, bytes: Buffer): boolean {
  const sig = sniffMagicBytes(bytes);
  const requireSignature: Record<string, MediaSignature> = {
    pdf: 'pdf',
    zip: 'zip',
    rar: 'rar',
    png: 'png',
    jpg: 'jpeg',
    jpeg: 'jpeg',
    webp: 'webp',
  };
  const expected = requireSignature[fileExtension(fileName)];
  if (expected) return sig === expected;
  // No reliable signature for this extension (CAD): allow ONLY if the bytes do
  // not sniff as some other recognized type.
  return sig === 'unknown';
}

/** Result of a successful upload verification + single-winner claim. */
interface OemUploadClaim {
  fileId: string;
  storageFileId: string;
  byteSize: number;
  checksumSha256: string;
}

/**
 * Verify a browser-direct OEM upload against its pending `files` row and CLAIM it
 * exactly once (MIU-08 §20.10 step 2). Ownership is proven ONLY by the one-time
 * `uploadSecret` (constant-time compared to the stored hash), so:
 *  - Structural / not-found / expired / WRONG-SECRET failures reject WITHOUT
 *    mutating anything — an unauthenticated caller who merely guesses a `fileId`
 *    must not be able to delete or fail a legitimate uploader's object.
 *  - Only AFTER the secret verifies do byte-level failures (size/checksum/sniff)
 *    mark the row `failed` and best-effort delete the object (the caller owns it).
 * The consume-once gate is an ATOMIC `incrementField` claim (storage-layer, not a
 * JS read-then-write): only the request that flips `finalizeClaim` 0→1 proceeds;
 * a concurrent double-submit / replay gets >1 and loses without side effects.
 */
async function verifyAndClaimOemUpload(input: {
  drawingFileId: string;
  uploadIntentId: string;
  uploadSecret: string;
}): Promise<{ ok: true; claim: OemUploadClaim } | { ok: false; error: ApiResult<unknown> }> {
  const fail = (error: ApiResult<unknown>) => ({ ok: false as const, error });
  const notFound = fail(err('NOT_FOUND', 'Upload not found.'));

  const doc = await get('files', input.drawingFileId);
  if (!doc) return notFound;
  if (doc.status !== 'pending') return fail(err('CONFLICT', 'This upload was already used.'));
  if (doc.purpose !== 'oem-drawing') return notFound;
  if (doc.uploadIntentId !== input.uploadIntentId) return notFound;
  const expiresAt =
    typeof doc.uploadExpiresAt === 'string' ? Date.parse(doc.uploadExpiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return fail(err('CONFLICT', 'This upload has expired. Please re-upload.'));
  }
  const provider = typeof doc.storageProvider === 'string' ? doc.storageProvider : '';
  if (provider !== 'cloudbase-storage' && provider !== 'local-disk') return notFound;
  if (typeof doc.storageFileId !== 'string' || doc.storageFileId.length === 0) return notFound;
  if (typeof doc.storagePath !== 'string' || !doc.storagePath.startsWith('oem/')) return notFound;
  if (typeof doc.uploadSecretHash !== 'string' || doc.uploadSecretHash.length === 0)
    return notFound;

  // Constant-time secret verification (the ONLY browser credential; §20.10). Guard
  // equal length first so timingSafeEqual never throws on a length mismatch.
  const presentedHash = createHash('sha256').update(input.uploadSecret).digest('hex');
  const storedHash = doc.uploadSecretHash;
  const secretOk =
    presentedHash.length === storedHash.length &&
    timingSafeEqual(Buffer.from(presentedHash), Buffer.from(storedHash));
  if (!secretOk) return fail(err('FORBIDDEN', 'Upload verification failed.'));

  // --- Ownership PROVEN by the secret. ---
  const storageFileId = doc.storageFileId;
  const fileName = typeof doc.name === 'string' ? doc.name : '';

  // Consume-once ATOMIC single-winner claim — placed BEFORE any object download or
  // destructive mutation (Codex `871adff` P1). A concurrent duplicate/replay
  // (same secret) loses HERE and returns CONFLICT without ever reading storage or
  // touching the row, so a valid secret cannot be used to amplify repeated ~10 MiB
  // downloads or race the destructive byte-failure path. It is AFTER secret
  // verification so a caller without the secret cannot burn it.
  const claim = await incrementField('files', input.drawingFileId, 'finalizeClaim', 1);
  if (claim === null) return notFound;
  if (claim !== 1) return fail(err('CONFLICT', 'This upload was already submitted.'));

  // --- WINNER-ONLY below. Byte-level failures may fail the row + delete the object.
  const rejectOwned = async (message: string) => {
    await updateDoc('files', input.drawingFileId, { status: 'failed' }).catch((e) =>
      console.error('[submitProject] mark-failed after rejection failed', e),
    );
    await mediaStorage()
      .deleteObject(storageFileId)
      .catch((e) => console.error('[submitProject] delete rejected object failed', e));
    return fail(err('VALIDATION_ERROR', message));
  };

  // Download AFTER the claim. Chosen retry behavior (Codex P1): releasing the claim
  // on a miss would be racy, and COS is read-after-write consistent, so a
  // not-yet-readable object is terminal for this (now consumed) intent — the row is
  // failed + the object best-effort deleted and the client uploads again. This
  // never leaves a half-finalized pending row and never runs a loser's download.
  let object: { body: string; byteSize?: number };
  try {
    object = await mediaStorage().getObjectAsBase64(storageFileId);
  } catch (e) {
    console.error('[submitProject] uploaded object not retrievable', e);
    return rejectOwned('Uploaded file could not be read. Please upload it again.');
  }

  const bytes = Buffer.from(object.body, 'base64');
  // The SERVER-recomputed length is authoritative — never trust the client size.
  const byteSize = bytes.byteLength;
  if (byteSize === 0) return rejectOwned('Uploaded file is empty.');
  if (byteSize > OEM_FILE_MAX_BYTES) return rejectOwned('Uploaded file exceeds the maximum size.');
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  if (typeof doc.checksumSha256 === 'string' && doc.checksumSha256 !== checksumSha256) {
    return rejectOwned('Uploaded bytes do not match the declared checksum.');
  }
  if (!oemBytesMatchType(fileName, bytes)) {
    return rejectOwned('File content does not match its type.');
  }

  return {
    ok: true,
    claim: { fileId: input.drawingFileId, storageFileId, byteSize, checksumSha256 },
  };
}

/**
 * Public OEM project enquiry. Anyone may submit; the request is persisted to the
 * `oemProjects` collection (visible to admins/contributors in the dashboard) and
 * the submitter receives a confirmation email with the new reference id. A drawing
 * may be attached three ways: the MIU-08 storage-upload triad (verified + claimed
 * here), a legacy inline base64 `drawingData`, or none.
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
    drawingData,
    drawingFileId,
    uploadIntentId,
    uploadSecret,
  } = parsed.data;
  const numericQuantity = quantity === undefined || quantity === '' ? undefined : Number(quantity);

  // The storage triad and legacy base64 are mutually exclusive; the triad must be
  // complete (all three) or it is rejected rather than silently dropping a drawing.
  const hasAnyStorageRef = Boolean(drawingFileId || uploadIntentId || uploadSecret);
  const hasFullStorageRef = Boolean(drawingFileId && uploadIntentId && uploadSecret);
  if (hasAnyStorageRef && !hasFullStorageRef) {
    return err('VALIDATION_ERROR', 'Incomplete upload reference.');
  }

  let drawingId = '';
  let claim: OemUploadClaim | undefined;
  if (drawingFileId && uploadIntentId && uploadSecret) {
    const finalized = await verifyAndClaimOemUpload({
      drawingFileId,
      uploadIntentId,
      uploadSecret,
    });
    if (!finalized.ok) return finalized.error;
    claim = finalized.claim;
    drawingId = claim.fileId; // still `pending`; activated AFTER the project exists
  } else if (drawingData) {
    // submitProject is UNAUTHENTICATED and files.mimeType is reflected by the
    // OEM download path, so the client-declared `drawingType` is NOT trusted:
    // derive the stored type from a byte sniff (a recognised signature → its
    // canonical MIME; anything else, incl. CAD, → octet-stream). This prevents
    // an anonymous caller persisting e.g. mimeType 'text/html' with HTML bytes.
    const sig = sniffMagicBytes(Buffer.from(drawingData, 'base64'));
    const fileDoc = await createDoc('files', {
      name: drawingName ?? 'drawing',
      mimeType: sig === 'unknown' ? 'application/octet-stream' : SIGNATURE_MIME[sig],
      data: drawingData,
    });
    drawingId = fileDoc._id;
  }

  const projectData = {
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
  };

  // A storage upload is already CLAIMED here, so failing to create the project must
  // not leave a zombie pending row — mark it failed and surface the error.
  let project: CollectionDoc;
  try {
    project = await createDoc('oemProjects', projectData);
  } catch (e) {
    console.error('[submitProject] project create failed', e);
    if (claim) {
      await updateDoc('files', claim.fileId, { status: 'failed' }).catch((err2) =>
        console.error('[submitProject] mark-failed after project-create failure failed', err2),
      );
    }
    return err('INTERNAL_ERROR', 'Could not submit your project. Please try again.');
  }

  if (claim) {
    // Activate the drawing AFTER the project exists and bind it. Compensation: if
    // activation fails, the project must not keep a dangling pending drawing —
    // remove it, mark the upload failed, and surface the error (never success).
    const activated = await updateDoc('files', claim.fileId, {
      status: 'active',
      ownerProjectId: project._id,
      byteSize: claim.byteSize,
      checksumSha256: claim.checksumSha256,
      uploadSecretHash: '',
    }).catch((e) => {
      console.error('[submitProject] activation failed after project create', e);
      return null;
    });
    if (!activated) {
      await remove('oemProjects', project._id).catch((e) =>
        console.error('[submitProject] project rollback failed', e),
      );
      await updateDoc('files', claim.fileId, { status: 'failed' }).catch((e) =>
        console.error('[submitProject] mark-failed after activation failure failed', e),
      );
      return err('INTERNAL_ERROR', 'Could not finalize the upload. Please try again.');
    }
  }

  // Best-effort acknowledgement; never block the submission on email delivery.
  await sendOemConfirmationEmail({
    to: email.toLowerCase(),
    contact,
    company,
    category: category ?? '',
    projectId: project._id,
  }).catch((e) => console.error('[submitProject] confirmation email failed:', e));

  return ok({ id: project._id });
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

async function backfillImageRefCountsAction(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  // Privileged one-shot reconciliation over every image counter — admins only
  // (contributors can edit catalog rows but not rewrite the visibility index).
  if (claims.role !== 'admin') {
    return err('FORBIDDEN', 'Only an admin may backfill image reference counts.');
  }
  const dryRun =
    !!req.data &&
    typeof req.data === 'object' &&
    (req.data as { dryRun?: unknown }).dryRun === true;
  const report = await backfillPublishedRefCounts({ dryRun });
  return ok(report);
}

/** Default orphan TTL: a `pending`/`failed` image older than this is treated as
 *  abandoned (the browser direct POST or completeUpload never finished). */
const ORPHAN_CLEANUP_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const ORPHAN_CLEANUP_MAX_LIMIT = 500;
const ORPHAN_CLEANUP_DB_PAGE_SIZE = 100;
const ORPHAN_CLEANUP_SORT = [{ field: '_id', dir: 'asc' as const }];

const cleanupOrphanImagesSchema = z.object({
  olderThanMs: z.number().int().positive().optional(),
  dryRun: z.boolean().optional(),
  limit: z.number().int().positive().max(ORPHAN_CLEANUP_MAX_LIMIT).optional(),
});

async function listOrphanCleanupCandidates(input: {
  cutoff: string;
  limit: number;
}): Promise<{ items: CollectionDoc[]; total: number }> {
  const items: CollectionDoc[] = [];
  let total = 0;
  let page = 1;
  const pageSize = Math.min(ORPHAN_CLEANUP_DB_PAGE_SIZE, input.limit);

  while (items.length < input.limit) {
    const res = await list({
      collection: 'images',
      page,
      pageSize,
      sort: ORPHAN_CLEANUP_SORT,
      filter: {
        combinator: 'and',
        clauses: [
          { field: 'status', op: 'in', value: ['pending', 'failed'] },
          { field: 'createdAt', op: 'lt', value: input.cutoff },
        ],
      },
    });

    if (page === 1) total = res.total;
    items.push(...res.items);
    if (res.items.length < pageSize) break;
    page += 1;
  }

  return { items: items.slice(0, input.limit), total };
}

/**
 * MIU-06 orphan cleanup. Reaps abandoned image documents — `pending` intents whose
 * upload never completed and `failed` rows from a rejected completeUpload — older
 * than a TTL, deleting the private storage object FIRST and only then the metadata.
 * A storage-delete failure leaves the row in place (reported, retried next sweep)
 * rather than silently orphaning bytes. Never touches `active` images (the live
 * catalog) and is admin-only. `dryRun` reports candidates without mutating. Storage
 * keys are logged; temporary URLs are not (§20.8 exit criteria).
 */
async function cleanupOrphanImagesAction(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  if (claims.role !== 'admin') {
    return err('FORBIDDEN', 'Only an admin may clean up orphaned uploads.');
  }
  const parsed = cleanupOrphanImagesSchema.safeParse(req.data ?? {});
  if (!parsed.success) return err('BAD_REQUEST', 'Invalid orphan-cleanup parameters');

  const ttlMs = parsed.data.olderThanMs ?? ORPHAN_CLEANUP_DEFAULT_TTL_MS;
  const dryRun = parsed.data.dryRun === true;
  const limit = parsed.data.limit ?? ORPHAN_CLEANUP_DB_PAGE_SIZE;
  // ISO timestamps sort chronologically as strings, so a `createdAt < cutoff`
  // filter selects rows older than the TTL on both adapters.
  const cutoff = new Date(Date.now() - ttlMs).toISOString();

  const candidates = await listOrphanCleanupCandidates({ cutoff, limit });

  const removed: string[] = [];
  const storageDeleted: string[] = [];
  const storageFailed: Array<{ id: string; error: string }> = [];

  for (const doc of candidates.items) {
    const id = String(doc._id);
    if (dryRun) {
      removed.push(id);
      continue;
    }
    const provider = typeof doc.storageProvider === 'string' ? doc.storageProvider : '';
    const storageFileId = typeof doc.storageFileId === 'string' ? doc.storageFileId : '';
    const hasObject =
      storageFileId.length > 0 && (provider === 'cloudbase-storage' || provider === 'local-disk');
    if (hasObject) {
      try {
        await mediaStorage().deleteObject(storageFileId);
        console.log(`[fn-admin] cleanupOrphanImages: deleted storage object ${storageFileId}`);
        storageDeleted.push(storageFileId);
      } catch (e) {
        // Keep the metadata so a later sweep retries; never silently orphan bytes.
        console.error(`[fn-admin] cleanupOrphanImages: object delete failed for ${id}`, e);
        storageFailed.push({ id, error: e instanceof Error ? e.message : 'storage delete failed' });
        continue;
      }
    }
    if (await remove('images', id)) removed.push(id);
  }

  return ok({
    dryRun,
    cutoff,
    scanned: candidates.items.length,
    total: candidates.total,
    docsRemoved: dryRun ? 0 : removed.length,
    removed,
    storageDeleted,
    storageFailed,
  });
}

const migrateLegacyImagesSchema = z.object({
  dryRun: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const LEGACY_MIGRATION_DB_PAGE_SIZE = 100;
const LEGACY_MIGRATION_SORT = [{ field: '_id', dir: 'asc' as const }];
// A legacy `data` field must be well-formed base64 to migrate; anything else is
// recorded as skipped (never aborts the batch). Buffer.from(..,'base64') is lenient
// (drops invalid chars silently), so screen the string before trusting a decode.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Page legacy migration candidates: inline `data` present and not yet staged
 * (`migrationStorageFileId` absent). Stable `_id` sort so skip/limit paging cannot
 * miss or duplicate rows; `data isNotEmpty`/`migrationStorageFileId isEmpty` select
 * un-migrated legacy rows on both adapters (CloudBase `$in:[null]` matches a missing
 * field; the local matcher treats undefined as empty).
 */
async function listLegacyImageCandidates(
  limit: number,
): Promise<{ items: CollectionDoc[]; total: number }> {
  const items: CollectionDoc[] = [];
  let total = 0;
  let page = 1;
  const pageSize = Math.min(LEGACY_MIGRATION_DB_PAGE_SIZE, limit);
  while (items.length < limit) {
    const res = await list({
      collection: 'images',
      page,
      pageSize,
      sort: LEGACY_MIGRATION_SORT,
      filter: {
        combinator: 'and',
        clauses: [
          { field: 'data', op: 'isNotEmpty' },
          { field: 'migrationStorageFileId', op: 'isEmpty' },
        ],
      },
    });
    if (page === 1) total = res.total;
    items.push(...res.items);
    if (res.items.length < pageSize) break;
    page += 1;
  }
  return { items: items.slice(0, limit), total };
}

/**
 * MIU-06 Phase 2 — legacy `images.data` → storage migration (rollback-safe, staged).
 * For each un-migrated legacy inline-base64 image: validate + decode the bytes,
 * upload them to catalog storage, and record STAGED fields
 * (`migrationStorageFileId`/`migrationStoragePath`/`migrationChecksumSha256`/
 * `migrationByteSize`/`migratedAt`) WITHOUT touching `data`, `storageProvider`,
 * `storageFileId`, or `status`. Delivery therefore keeps serving the legacy bytes,
 * a later cutover can flip the provider once storage-backed delivery is proven, and
 * rollback is free (ignore the staged fields). Admin-only; `dryRun` reports
 * candidates without writing; idempotent (already-staged rows are filtered out); a
 * malformed/oversize/upload-failed row is recorded in `skipped` and never aborts the
 * batch (§20.8).
 */
async function migrateLegacyImagesAction(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  if (claims.role !== 'admin') {
    return err('FORBIDDEN', 'Only an admin may migrate legacy images.');
  }
  const parsed = migrateLegacyImagesSchema.safeParse(req.data ?? {});
  if (!parsed.success) return err('BAD_REQUEST', 'Invalid migration parameters');
  const dryRun = parsed.data.dryRun === true;
  const limit = parsed.data.limit ?? LEGACY_MIGRATION_DB_PAGE_SIZE;

  const candidates = await listLegacyImageCandidates(limit);
  const migrated: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  // Best-effort delete of an object whose metadata staging failed AFTER a
  // successful upload, so a post-upload failure never leaks private bytes with no
  // doc pointer (which cleanupOrphanImages cannot see and a re-run would duplicate
  // — STO-004). If the compensating delete ALSO fails, the object is genuinely
  // leaked: report it explicitly so an operator can clean it up.
  const rollbackUpload = async (imageId: string, fileId: string, reason: string): Promise<void> => {
    try {
      await mediaStorage().deleteObject(fileId);
      skipped.push({ id: imageId, reason: `${reason}; uploaded object rolled back` });
    } catch (delErr) {
      const dm = delErr instanceof Error ? delErr.message : 'delete failed';
      console.error(
        `[fn-admin] migrateLegacyImages: LEAKED storage object ${fileId} for ${imageId} (rollback delete failed)`,
        delErr,
      );
      skipped.push({
        id: imageId,
        reason: `${reason}; ROLLBACK FAILED — leaked storage object ${fileId} (${dm})`,
      });
    }
  };

  for (const doc of candidates.items) {
    const id = String(doc._id);
    const data = typeof doc.data === 'string' ? doc.data : '';
    if (!data || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      skipped.push({ id, reason: 'missing or malformed base64 data' });
      continue;
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.byteLength === 0) {
      skipped.push({ id, reason: 'empty decoded bytes' });
      continue;
    }
    if (bytes.byteLength > CATALOG_IMAGE_MAX_BYTES) {
      skipped.push({ id, reason: 'decoded bytes exceed the catalog image size cap' });
      continue;
    }
    if (dryRun) {
      migrated.push(id);
      continue;
    }
    const mimeType = typeof doc.mimeType === 'string' ? doc.mimeType : 'application/octet-stream';
    const name = typeof doc.name === 'string' && doc.name.length > 0 ? doc.name : `${id}.bin`;

    // 1) Upload first. A pure upload failure leaves NO object → just skip + retry.
    let stored: StoredMediaObject;
    try {
      stored = await mediaStorage().putObject({
        namespace: 'catalog',
        logicalId: id,
        fileName: `migrated-${name}`,
        mimeType,
        content: bytes,
      });
    } catch (e) {
      console.error(`[fn-admin] migrateLegacyImages: upload failed for ${id}`, e);
      skipped.push({ id, reason: e instanceof Error ? e.message : 'storage upload failed' });
      continue;
    }

    // 2) Stage the pointer. From here an object EXISTS, so any staging failure must
    // be compensated (delete it) — never leave orphaned bytes. Staged fields ONLY:
    // data/provider/storageFileId/status stay untouched so delivery is unchanged.
    let staged: CollectionDoc | null = null;
    let stageError: unknown;
    try {
      staged = await updateDoc('images', id, {
        migrationStorageFileId: stored.storageFileId,
        migrationStoragePath: stored.storagePath,
        migrationChecksumSha256: createHash('sha256').update(bytes).digest('hex'),
        migrationByteSize: bytes.byteLength,
        migratedAt: new Date().toISOString(),
      });
    } catch (e) {
      stageError = e;
    }
    if (staged) {
      migrated.push(id);
      continue;
    }
    // `null` return = the row vanished (concurrent remove) between query and stage.
    await rollbackUpload(
      id,
      stored.storageFileId,
      stageError instanceof Error
        ? `staging failed after upload: ${stageError.message}`
        : 'image row no longer exists at stage time',
    );
  }

  return ok({
    dryRun,
    scanned: candidates.items.length,
    total: candidates.total,
    migratedCount: dryRun ? 0 : migrated.length,
    migrated,
    skipped,
  });
}

/**
 * Step 1 of the admin-brokered direct upload (MIU-Upload). Validates the file
 * metadata, mints a single-object pre-signed credential, and writes a `pending`
 * image doc. The browser then POSTs a multipart form straight to COS and calls
 * `completeUpload`. The credential is minted FIRST so a mint failure never leaves
 * an orphan doc; the bytes don't exist until the browser direct POST, so a
 * half-finished intent is just a pending (never-public) doc for orphan cleanup.
 */
async function createUploadIntentAction(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  if (!canEditCollection(claims.role, 'images')) {
    return err('FORBIDDEN', 'You do not have permission to upload images.');
  }
  const parsed = catalogImageUploadSchema.safeParse(req.data);
  if (!parsed.success) {
    return err('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '));
  }

  // The path segment uses the intent id (a fresh UUID), so the credential can be
  // minted before any DB write.
  const uploadIntentId = randomUUID();
  const cloudPath = catalogStoragePath({
    imageId: uploadIntentId,
    role: 'original',
    fileName: parsed.data.fileName,
  });
  const credential = await mediaStorage().getUploadCredential(cloudPath);

  const pending = await createDoc('images', {
    name: parsed.data.fileName,
    mimeType: parsed.data.mimeType,
    purpose: parsed.data.purpose,
    storageProvider: 'cloudbase-storage',
    storageMode: 'classic-nosql-storage',
    storagePath: cloudPath,
    storageFileId: credential.storageFileId,
    status: 'pending',
    publishedRefCount: 0,
    uploadIntentId,
    byteSize: parsed.data.byteSize,
    ...(parsed.data.checksumSha256 ? { checksumSha256: parsed.data.checksumSha256 } : {}),
  });

  return ok({
    imageId: pending._id,
    uploadIntentId,
    storageFileId: credential.storageFileId,
    upload: {
      method: credential.method,
      url: credential.uploadUrl,
      // Browser appends these to multipart/form-data before the file part.
      fields: credential.formFields,
    },
  });
}

/**
 * Step 3 of the admin-brokered upload. Verifies the bytes actually landed,
 * recomputes size + SHA-256 SERVER-SIDE (never trusts the client; §22.3-6), and
 * flips the pending doc to `active`. A SIZE or CHECKSUM verification failure marks
 * the doc `failed` (and best-effort deletes the bad object). A not-yet-retrievable
 * object leaves the doc `pending` (retryable; reaped by orphan cleanup if
 * abandoned) — it is never dead-ended. Pending/failed are never public.
 */
async function completeUploadAction(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  if (!canEditCollection(claims.role, 'images')) {
    return err('FORBIDDEN', 'You do not have permission to upload images.');
  }
  const parsed = completeUploadSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'imageId is required');

  const doc = await get('images', parsed.data.imageId);
  if (!doc) return err('NOT_FOUND', 'Upload intent not found');
  if (doc.status !== 'pending') return err('CONFLICT', 'This upload was already finalized');
  if (typeof doc.storageFileId !== 'string') {
    return err('INTERNAL_ERROR', 'Upload intent is missing its storage id');
  }

  const storageFileId = doc.storageFileId;
  const imageId = parsed.data.imageId;

  let object: { body: string; byteSize?: number };
  try {
    object = await mediaStorage().getObjectAsBase64(storageFileId);
  } catch (e) {
    // The bytes are not retrievable (yet). This may be a transient / eventually
    // consistent miss OR a PUT that never happened. Either way, leave the doc
    // PENDING (never public) and let the caller retry; a truly abandoned intent
    // is reaped by orphan cleanup (MIU-06). Do NOT dead-end it to `failed`.
    console.error('[fn-admin] completeUpload: object not retrievable (left pending)', e);
    return err(
      'NOT_FOUND',
      'Uploaded object not found yet — retry completeUpload once the PUT finishes.',
    );
  }

  // The object IS present but fails verification below → mark `failed` and make a
  // best-effort delete of the bad bytes (compensation; MIU-06 also sweeps).
  const rejectInvalid = async (message: string): Promise<ApiResult<unknown>> => {
    await updateDoc('images', imageId, { status: 'failed' });
    await mediaStorage()
      .deleteObject(storageFileId)
      .catch((e) =>
        console.error('[fn-admin] completeUpload: could not delete rejected object', e),
      );
    return err('VALIDATION_ERROR', message);
  };

  const bytes = Buffer.from(object.body, 'base64');
  const byteSize = object.byteSize ?? bytes.byteLength;

  // Re-enforce the catalog size cap against the REAL bytes. The pre-signed
  // credential is unbounded and the intent-time `byteSize` was only a
  // client-declared hint, so the cap MUST be checked here (contract §22.3-6).
  if (byteSize > CATALOG_IMAGE_MAX_BYTES) {
    return rejectInvalid('Uploaded object exceeds the maximum allowed size.');
  }

  // Recompute SHA-256 server-side; if the client declared one, the bytes that
  // landed must match it — otherwise the object was tampered with or truncated.
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  if (typeof doc.checksumSha256 === 'string' && doc.checksumSha256 !== checksumSha256) {
    return rejectInvalid('Uploaded bytes do not match the declared checksum.');
  }

  // The pre-signed credential fixes only the object KEY, not the content, so
  // the landed bytes may be anything the browser PUT. Require the magic bytes
  // to match the intent's declared (allowlisted) image MIME — an HTML/JS
  // payload behind an image name must never activate, because `mimeType` is
  // reflected into the public delivery Content-Type. Mirrors the OEM path's
  // `oemBytesMatchType` sniff.
  const declaredMime = typeof doc.mimeType === 'string' ? doc.mimeType : '';
  if (!signatureMatchesMime(sniffMagicBytes(bytes), declaredMime)) {
    return rejectInvalid('Uploaded bytes are not a valid image of the declared type.');
  }

  const activated = await updateDoc('images', imageId, {
    status: 'active',
    byteSize,
    checksumSha256,
  });
  return ok({
    imageId,
    status: 'active',
    byteSize,
    ...(activated ? { image: redact('images', activated) } : {}),
  });
}

/**
 * Admin-authenticated image preview. Returns the bytes (base64) for ANY image the
 * caller may read, REGARDLESS of publication — so the dashboard can preview a
 * freshly-uploaded (active, `publishedRefCount: 0`) or unpublished image. The
 * PUBLIC `/api/images/:id` route stays `publishedRefCount`-gated (storefront
 * visibility); this is the admin's preview channel. Legacy rows return their
 * inline `data`; storage-backed rows are proxied through the media adapter.
 */
async function getImagePreviewAction(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  if (!canReadCollection(claims.role, 'images')) {
    return err('FORBIDDEN', 'You do not have permission to view images.');
  }
  const parsed = imagePreviewSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'id is required');

  const doc = await get('images', parsed.data.id);
  if (!doc) return err('NOT_FOUND', 'Image not found');
  const mimeType = typeof doc.mimeType === 'string' ? doc.mimeType : 'application/octet-stream';

  if (typeof doc.data === 'string') {
    return ok({ id: parsed.data.id, mimeType, dataBase64: doc.data });
  }
  // Storage-backed: serve ONLY recognized-provider + `active` rows. Active rows
  // have passed completeUpload's size/checksum verification, so this can't be used
  // to download an unverified/oversized pending object, a rejected `failed` row,
  // a `deleted` row, or an unknown/corrupt provider. Pre-activation (pending)
  // previews are the client's job (URL.createObjectURL on the just-uploaded File).
  const provider = typeof doc.storageProvider === 'string' ? doc.storageProvider : '';
  const isStorageProvider = provider === 'cloudbase-storage' || provider === 'local-disk';
  if (isStorageProvider && doc.status === 'active' && typeof doc.storageFileId === 'string') {
    try {
      const object = await mediaStorage().getObjectAsBase64(doc.storageFileId);
      return ok({ id: parsed.data.id, mimeType, dataBase64: object.body });
    } catch (e) {
      console.error('[fn-admin] getImagePreview: storage fetch failed', e);
      return err('NOT_FOUND', 'Image bytes are unavailable');
    }
  }
  return err('NOT_FOUND', 'Image not available for preview');
}

/**
 * Admin-authenticated OEM-file delivery (MIU-08, §20.10 step 3). Returns a
 * SHORT-lived temp URL for a private OEM attachment plus a sanitized filename and
 * a forced `attachment` disposition — never the bytes through JSON/base64 (10 MiB
 * OEM files must not be proxied through the function body cap).
 *
 * Only a fully-finalized attachment is deliverable: `purpose: 'oem-drawing'`,
 * `status: 'active'` (so it passed submitProject verification), a recognized
 * storage provider, and an `ownerProjectId` (so an un-finalized pending intent
 * can never be fetched). The TTL is deliberately tiny and re-minted per request
 * because CDN edges can outlive object deletion (MIU-00); the URL is never
 * persisted. The filename is sanitized to strip CR/LF/quotes/path separators/
 * control + bidi characters, defeating header-injection and RTL-spoof downloads.
 */
async function getOemFileDownloadUrlAction(
  req: AdminRequest,
  claims: SessionClaims,
): Promise<ApiResult<unknown>> {
  if (!canReadCollection(claims.role, 'files')) {
    return err('FORBIDDEN', 'You do not have permission to download OEM files.');
  }
  const parsed = oemFileDownloadSchema.safeParse(req.data);
  if (!parsed.success) return err('BAD_REQUEST', 'fileId is required');

  const doc = await get('files', parsed.data.fileId);
  if (!doc) return err('NOT_FOUND', 'File not found');
  // Deliver ONLY a finalized, storage-backed OEM attachment. Every guard below
  // fails closed to NOT_FOUND so a pending/failed/legacy/foreign row cannot be
  // turned into a download link by id enumeration.
  if (doc.purpose !== 'oem-drawing') return err('NOT_FOUND', 'File is not an OEM drawing');
  if (doc.status !== 'active') return err('NOT_FOUND', 'File is not available for download');
  if (typeof doc.ownerProjectId !== 'string' || doc.ownerProjectId.length === 0) {
    return err('NOT_FOUND', 'File is not linked to a project');
  }
  const provider = typeof doc.storageProvider === 'string' ? doc.storageProvider : '';
  const isStorageProvider = provider === 'cloudbase-storage' || provider === 'local-disk';
  if (!isStorageProvider || typeof doc.storageFileId !== 'string') {
    return err('NOT_FOUND', 'File bytes are unavailable');
  }

  let temp: { url: string; expiresAt?: string };
  try {
    temp = await mediaStorage().getTempUrl(doc.storageFileId, OEM_DOWNLOAD_URL_TTL_SECONDS);
  } catch (e) {
    console.error('[fn-admin] getOemFileDownloadUrl: temp URL mint failed', e);
    return err('NOT_FOUND', 'File bytes are unavailable');
  }

  const rawName = typeof doc.name === 'string' ? doc.name : '';
  const fileName = sanitizeDownloadFilename(rawName, 'oem-drawing');
  const mimeType = typeof doc.mimeType === 'string' ? doc.mimeType : 'application/octet-stream';
  return ok({
    fileId: parsed.data.fileId,
    url: temp.url,
    ...(temp.expiresAt ? { expiresAt: temp.expiresAt } : {}),
    fileName,
    mimeType,
    // Any proxy/header path MUST force a download (never inline-render an OEM
    // attachment) with the sanitized name.
    contentDisposition: `attachment; filename="${fileName}"`,
  });
}

/** Count `files` matching an AND-filter, using `list().total` (no doc fetch). */
async function countOemFiles(clauses: FilterClause[]): Promise<number> {
  const res = await list({
    collection: 'files',
    page: 1,
    pageSize: 1,
    filter: { combinator: 'and', clauses },
  });
  return res.total;
}

/**
 * MIU-08 §20.10 step 1 — PUBLIC OEM upload-intent creation (no admin JWT). Mints a
 * single-object browser->COS upload credential so a ≤10 MiB OEM attachment never
 * transits the function body cap, and records a `pending` `files` row bound to a
 * one-time upload secret (only its hash is stored) with a short expiry.
 *
 * Because it is unauthenticated it is an abuse surface, so it enforces (fail-safe)
 * a fixed-window rate limit and a concurrent pending-intent cap, each per-source
 * (hashed client IP) AND against a global emergency ceiling (CloudBase may not
 * expose a trusted IP; an absent source collapses into the global bucket). To make
 * the caps hold under concurrency it uses a RESERVE-FIRST order — write the pending
 * row, then count it in — so admitted reservations are always ≤ the ceiling and a
 * denied one is rolled back (see the inline note); the raw IP is never persisted.
 */
/** How many expired pending OEM uploads a single intent call may opportunistically reap. */
const OEM_PENDING_SWEEP_LIMIT = 3;

/**
 * Reap a bounded, oldest-first batch of EXPIRED `pending` OEM upload rows: delete
 * the private `oem/` object FIRST, then retire the paired row only when that delete
 * succeeds (or there was never an object). A storage-delete failure leaves the row
 * for the next sweep — never orphan bytes, never over-delete. Piggybacked
 * best-effort on `createOemFileUploadIntent` so the UNAUTHENTICATED OEM surface
 * self-heals without a scheduler (uses the shared `selectExpiredPendingForSweep`
 * selection primitive, §20.13/§27.2).
 */
async function sweepExpiredOemPendingUploads(limit: number): Promise<{
  swept: string[];
  storageDeleted: string[];
  storageFailed: Array<{ id: string; error: string }>;
}> {
  const swept: string[] = [];
  const storageDeleted: string[] = [];
  const storageFailed: Array<{ id: string; error: string }> = [];
  if (!Number.isInteger(limit) || limit <= 0) return { swept, storageDeleted, storageFailed };

  const now = new Date();
  const page = await list({
    collection: 'files',
    page: 1,
    pageSize: limit,
    sort: [{ field: 'uploadExpiresAt', dir: 'asc' }],
    filter: {
      combinator: 'and',
      clauses: [
        { field: 'purpose', op: 'eq', value: 'oem-drawing' },
        { field: 'status', op: 'eq', value: 'pending' },
        { field: 'uploadExpiresAt', op: 'lt', value: now.toISOString() },
      ],
    },
  });
  const selection = selectExpiredPendingForSweep(
    page.items.map((d) => ({
      _id: String(d._id),
      status: (typeof d.status === 'string' ? d.status : 'pending') as MediaStatus,
      ...(typeof d.uploadExpiresAt === 'string' ? { uploadExpiresAt: d.uploadExpiresAt } : {}),
      ...(typeof d.storageFileId === 'string' ? { storageFileId: d.storageFileId } : {}),
    })),
    now,
    limit,
  );
  for (const item of selection.items) {
    // Delete the object FIRST; retire the row only if that succeeds (or there is no
    // object). A delete failure leaves the row for the next sweep.
    if (typeof item.storageFileId === 'string' && item.storageFileId.length > 0) {
      try {
        await mediaStorage().deleteObject(item.storageFileId);
        storageDeleted.push(item.storageFileId);
      } catch (e) {
        console.error(`[fn-admin] OEM sweep: object delete failed for ${item.docId}`, e);
        storageFailed.push({
          id: item.docId,
          error: e instanceof Error ? e.message : 'storage delete failed',
        });
        continue;
      }
    }
    if (await remove('files', item.docId)) swept.push(item.docId);
  }
  return { swept, storageDeleted, storageFailed };
}

async function createOemFileUploadIntentAction(
  req: AdminRequest,
  context?: RequestContext,
): Promise<ApiResult<unknown>> {
  const parsed = oemFileUploadSchema.safeParse(req.data);
  if (!parsed.success) {
    return err('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '));
  }

  // Self-heal the unauthenticated OEM surface: opportunistically reap a small,
  // bounded batch of EXPIRED pending uploads (delete orphaned `oem/` objects +
  // retire rows) so abandoned anonymous intents cannot accumulate bucket pollution.
  // Best-effort — a sweep failure never blocks a legitimate new upload.
  await sweepExpiredOemPendingUploads(OEM_PENDING_SWEEP_LIMIT).catch((e) =>
    console.error('[fn-admin] createOemFileUploadIntent: expired-pending sweep failed', e),
  );

  const now = Date.now();
  // Epoch-aligned window start, matching evaluateFixedWindowRateLimit's Retry-After.
  const windowStartIso = new Date(
    Math.floor(now / OEM_UPLOAD_RATE_WINDOW_MS) * OEM_UPLOAD_RATE_WINDOW_MS,
  ).toISOString();
  const nowIso = new Date(now).toISOString();

  // Source key = SHA-256 of the client IP when available; the raw IP is never
  // stored. Absent/spoofed source falls through to the global ceilings only.
  const sourceIp = context?.sourceIp?.trim();
  const uploadSourceHash = sourceIp
    ? createHash('sha256').update(sourceIp).digest('hex')
    : undefined;

  const oemDrawing: FilterClause = { field: 'purpose', op: 'eq', value: 'oem-drawing' };
  const tooMany = (retryAfterSeconds: number): ApiResult<unknown> =>
    rateLimited(
      `Too many upload requests. Please retry in ${retryAfterSeconds}s.`,
      retryAfterSeconds,
    );
  const tooManyPending = (retryAfterSeconds: number): ApiResult<unknown> =>
    rateLimited(
      'Too many pending uploads. Finish or wait for the existing ones to expire.',
      retryAfterSeconds,
    );

  // Reserve-first abuse control: WRITE the pending row before counting, then
  // count (this reservation included) and roll it back if any ceiling is
  // exceeded. Because every ADMITTED reservation persists and is visible to
  // concurrent counters, no cap can admit more than its ceiling even under a
  // burst — closing the read-then-write race where a check-then-create ordering
  // let callers overshoot the cap before any 429 (Codex `724d70c` P1). It fails
  // SAFE: under contention it may over-REJECT (extra 429s) but never over-admit.
  // (A literal atomic `incrementField` counter — design §27.2-2 — is an
  // alternative mechanism; reserve-first reuses the `files` rows we already write,
  // so it needs no per-window counter docs, no counter GC, and no new storage
  // primitive/CloudBase SDK surface.)
  const uploadIntentId = randomUUID();
  const cloudPath = objectStoragePath({
    namespace: 'oem',
    logicalId: uploadIntentId,
    fileName: parsed.data.fileName,
  });
  // One-time secret: only the client that created this intent can finalize it
  // (§20.10 anti-enumeration). Store ONLY the hash; hand the plaintext back once.
  const uploadSecret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
  const uploadSecretHash = createHash('sha256').update(uploadSecret).digest('hex');

  const reserved = await createDoc('files', {
    name: parsed.data.fileName,
    mimeType: parsed.data.mimeType,
    purpose: 'oem-drawing',
    storageProvider: 'cloudbase-storage',
    storageMode: 'classic-nosql-storage',
    storagePath: cloudPath,
    status: 'pending',
    // Initialise the single-winner claim counter so finalization increments a
    // concrete field. NOTE: the live OEM failure was NOT absent-field semantics —
    // wx-server-sdk's `db.command.inc` does not apply in the Tencent CloudBase
    // runtime; the real fix routes `incrementField`'s atomic inc through
    // @cloudbase/node-sdk (see packages/db/src/cloudbase-adapter.ts). Keeping the
    // explicit `0` mirrors `images.publishedRefCount` and keeps the field concrete.
    finalizeClaim: 0,
    uploadIntentId,
    uploadSecretHash,
    uploadExpiresAt: new Date(now + OEM_UPLOAD_INTENT_TTL_MS).toISOString(),
    byteSize: parsed.data.byteSize,
    // Stamp createdAt explicitly so the fixed-window rate query counts this
    // reservation identically on every adapter (the in-memory test fake does not
    // auto-stamp createdAt; the real adapters overwrite it with an equivalent now).
    createdAt: nowIso,
    ...(parsed.data.checksumSha256 ? { checksumSha256: parsed.data.checksumSha256 } : {}),
    ...(uploadSourceHash ? { uploadSourceHash } : {}),
  });
  const rollback = async (): Promise<void> => {
    await remove('files', reserved._id).catch((e) =>
      console.error('[fn-admin] createOemFileUploadIntent: reservation rollback failed', e),
    );
  };

  // --- Fixed-window rate limit (reservation included): global then per-source -
  const inWindow: FilterClause[] = [
    oemDrawing,
    { field: 'createdAt', op: 'gte', value: windowStartIso },
  ];
  const globalRate = evaluateFixedWindowRateLimit({
    // The reservation is already persisted, so the count IS the post-increment
    // window total — allowed iff it stays within the ceiling (no speculative +1).
    countInWindow: await countOemFiles(inWindow),
    maxPerWindow: OEM_UPLOAD_RATE_MAX_PER_WINDOW_GLOBAL,
    windowMs: OEM_UPLOAD_RATE_WINDOW_MS,
    nowMs: now,
  });
  if (!globalRate.allowed) {
    await rollback();
    return tooMany(globalRate.retryAfterSeconds);
  }
  if (uploadSourceHash) {
    const sourceRate = evaluateFixedWindowRateLimit({
      countInWindow: await countOemFiles([
        ...inWindow,
        { field: 'uploadSourceHash', op: 'eq', value: uploadSourceHash },
      ]),
      maxPerWindow: OEM_UPLOAD_RATE_MAX_PER_WINDOW,
      windowMs: OEM_UPLOAD_RATE_WINDOW_MS,
      nowMs: now,
    });
    if (!sourceRate.allowed) {
      await rollback();
      return tooMany(sourceRate.retryAfterSeconds);
    }
  }

  // --- Concurrent pending-intent cap (reservation included) ------------------
  const pendingLive: FilterClause[] = [
    oemDrawing,
    { field: 'status', op: 'eq', value: 'pending' },
    { field: 'uploadExpiresAt', op: 'gt', value: nowIso },
  ];
  // The reservation is one of the live pending rows, so subtract it to recover
  // the count that PRECEDES this request (withinPendingCap allows `< cap`).
  const globalPending = await countOemFiles(pendingLive);
  if (!withinPendingCap(globalPending - 1, OEM_MAX_PENDING_INTENTS_GLOBAL)) {
    await rollback();
    return tooManyPending(await soonestPendingRetryAfterSeconds(pendingLive, now));
  }
  if (uploadSourceHash) {
    const sourceClauses: FilterClause[] = [
      ...pendingLive,
      { field: 'uploadSourceHash', op: 'eq', value: uploadSourceHash },
    ];
    const sourcePending = await countOemFiles(sourceClauses);
    if (!withinPendingCap(sourcePending - 1, OEM_MAX_PENDING_INTENTS_PER_SOURCE)) {
      await rollback();
      return tooManyPending(await soonestPendingRetryAfterSeconds(sourceClauses, now));
    }
  }

  // --- All caps cleared → mint the credential and attach it to the reservation
  let credential: Awaited<ReturnType<ReturnType<typeof mediaStorage>['getUploadCredential']>>;
  try {
    credential = await mediaStorage().getUploadCredential(cloudPath);
  } catch (e) {
    console.error('[fn-admin] createOemFileUploadIntent: credential mint failed', e);
    await rollback();
    return err('INTERNAL_ERROR', 'Could not start the upload. Please try again.');
  }

  try {
    const attached = await updateDoc('files', reserved._id, {
      storageFileId: credential.storageFileId,
    });
    if (!attached) {
      console.error(
        '[fn-admin] createOemFileUploadIntent: reservation vanished before storageFileId attach',
      );
      await rollback();
      return err('INTERNAL_ERROR', 'Could not start the upload. Please try again.');
    }
  } catch (e) {
    console.error('[fn-admin] createOemFileUploadIntent: storageFileId attach failed', e);
    await rollback();
    return err('INTERNAL_ERROR', 'Could not start the upload. Please try again.');
  }

  return ok({
    fileId: reserved._id,
    uploadIntentId,
    // Returned exactly once; the server keeps only the hash.
    uploadSecret,
    upload: {
      method: credential.method,
      url: credential.uploadUrl,
      fields: credential.formFields,
    },
  });
}

async function soonestPendingRetryAfterSeconds(
  clauses: FilterClause[],
  nowMs: number,
): Promise<number> {
  const res = await list({
    collection: 'files',
    page: 1,
    pageSize: 1,
    filter: { combinator: 'and', clauses },
    sort: [{ field: 'uploadExpiresAt', dir: 'asc' }],
  });
  const expiresAt = res.items[0]?.uploadExpiresAt;
  const expiresAtMs = typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) {
    return Math.ceil(OEM_UPLOAD_INTENT_TTL_MS / 1000);
  }
  return Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000));
}
