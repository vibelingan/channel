import { createAlibabaClient } from '@vibelingan-channel/alibaba-catalog-sync';
/**
 * Action handler for the alibaba-catalog-sync function (MIU 5 surface).
 *
 * POST actions (admin-authenticated, Bearer/JSON — never cookies): oauthStart,
 * connectionStatus, disconnect, and inspectProductDetail. The OAuth callback
 * arrives as a GET routed by the HTTP adapter (unauthenticated, state-bound,
 * rate-limited). Run controls, linking, and quarantine actions also live here.
 *
 * Authorization: every connection-lifecycle action requires the LIVE users
 * row to carry role 'admin' (NOT canAccessAdmin — contributors must not
 * manage the merchant credential; R1 L6).
 */
import { verifySession } from '@vibelingan-channel/auth/jwt';
import { type ApiResult, err, ok, toRole } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { type AlertSender, createAlertSender } from './alerts.ts';
import { type AlibabaSyncFunctionConfig, resolveOAuthConfig } from './config.ts';
import { inspectAlibabaProductDetail, isAlibabaProductId } from './detail-inspection.ts';

export type { AlibabaSyncFunctionConfig } from './config.ts';
import { linkExistingProduct, setPinnedOffer, unlinkProduct } from './linking.ts';
import { importCandidateImage, removeImportedCandidate } from './media-import.ts';
import { recentAttempts } from './oauth-attempts.ts';
import {
  type OAuthDeps,
  connectionStatusView,
  disconnectConnection,
  getConnectionAccessToken,
  handleOAuthCallback,
  probeConnection,
  startOAuth,
} from './oauth.ts';
import { approveQuarantinedRun } from './quarantine.ts';
import { enforceOAuthRateLimit, hashSourceIp } from './rate-limit.ts';
import { replayAlibabaRawPage } from './raw-replay.ts';
import { getDoc } from './repo.ts';
import { runSyncTick } from './runner.ts';

export interface AlibabaSyncRequest {
  action?: unknown;
  token?: unknown;
  data?: unknown;
}

export interface RequestContext {
  sourceIp?: string;
}

const requestSchema = z.object({
  action: z.string().min(1),
  token: z.string().optional(),
  data: z.unknown().optional(),
});

interface AdminIdentity {
  userId: string;
}

async function requireLiveAdmin(
  config: AlibabaSyncFunctionConfig,
  token: unknown,
): Promise<ApiResult<AdminIdentity>> {
  if (typeof token !== 'string' || token.length === 0) {
    return err('UNAUTHORIZED', 'Sign in required.');
  }
  const claims = await verifySession(config.jwtSecret, token);
  if (!claims) return err('UNAUTHORIZED', 'Session is invalid or expired.');
  const user = await getDoc('users', claims.sub);
  if (!user || user.status === 'suspended') {
    return err('UNAUTHORIZED', 'Session is invalid or expired.');
  }
  if (toRole(user.role) !== 'admin') {
    return err('FORBIDDEN', 'Managing the Alibaba connection requires the admin role.');
  }
  return ok({ userId: claims.sub });
}

export interface OAuthRuntime {
  deps: OAuthDeps;
}

export type RuntimeResolution =
  | { ok: true; runtime: OAuthRuntime }
  | { ok: false; missing: string[] };

/** Build the OAuth runtime lazily; unconfigured environments report what is missing. */
export function resolveRuntime(
  config: AlibabaSyncFunctionConfig,
  overrides?: { fetchImpl?: typeof fetch; now?: () => string; alert?: AlertSender },
): RuntimeResolution {
  const resolved = resolveOAuthConfig(config);
  if (!resolved.ok) return { ok: false, missing: resolved.missing };
  const nowIso = overrides?.now ?? (() => new Date().toISOString());
  const client = createAlibabaClient({
    appKey: resolved.config.appKey,
    appSecret: resolved.config.appSecret,
    endpoints: resolved.config.endpoints,
    ...(overrides?.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    now: () => Date.parse(nowIso()),
  });
  const alert =
    overrides?.alert ?? createAlertSender(config.wecomWebhookUrl, overrides?.fetchImpl ?? fetch);
  return {
    ok: true,
    runtime: {
      deps: {
        client,
        endpoints: resolved.config.endpoints,
        appKey: resolved.config.appKey,
        callbackUrl: resolved.config.callbackUrl,
        tokenKey: resolved.config.tokenKey,
        now: nowIso,
        alert,
      },
    },
  };
}

const NOT_CONFIGURED_MESSAGE =
  'The Alibaba connection is not configured in this environment. Missing: ';

export async function handleAlibabaSyncRequest(
  request: AlibabaSyncRequest,
  config: AlibabaSyncFunctionConfig,
  _context: RequestContext = {},
  runtimeOverrides?: Parameters<typeof resolveRuntime>[1],
): Promise<ApiResult<unknown>> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) return err('BAD_REQUEST', 'Malformed request envelope.');
  const { action, token } = parsed.data;

  switch (action) {
    case 'oauthStart': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const runtime = resolveRuntime(config, runtimeOverrides);
      if (!runtime.ok) {
        return err('CONFLICT', NOT_CONFIGURED_MESSAGE + runtime.missing.join(', '));
      }
      const started = await startOAuth(runtime.runtime.deps, admin.data.userId);
      if (!started.ok) return err('INTERNAL_ERROR', 'Could not start the authorization flow.');
      return ok({ authorizeUrl: started.authorizeUrl });
    }
    case 'oauthAttempts': {
      // Admin-only diagnostic read. The projection in recentAttempts() is the
      // redaction boundary — it names the safe fields explicitly rather than
      // filtering a document, so a new field cannot leak by being added.
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      return ok({ attempts: await recentAttempts(10) });
    }
    case 'connectionStatus': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const runtime = resolveRuntime(config, runtimeOverrides);
      const view = await connectionStatusView();
      return ok({
        ...view,
        notConfigured: !runtime.ok,
        ...(runtime.ok ? {} : { missing: runtime.missing }),
      });
    }
    case 'disconnect': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const existed = await disconnectConnection({ now: () => new Date().toISOString() });
      return ok({ disconnected: existed });
    }
    case 'linkProduct': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const payload = linkSchema.safeParse(parsed.data.data);
      if (!payload.success) return err('VALIDATION_ERROR', 'sourceKey and productId are required.');
      const result = await linkExistingProduct(payload.data.sourceKey, payload.data.productId, {
        now: new Date().toISOString(),
        userId: admin.data.userId,
      });
      if (!result.ok) {
        if (result.reason === 'source-linked-elsewhere') {
          return err('CONFLICT', 'This source product is already linked to another product.');
        }
        return err('NOT_FOUND', `Link failed: ${result.reason}.`);
      }
      return ok(result);
    }
    case 'unlinkProduct': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const payload = unlinkSchema.safeParse(parsed.data.data);
      if (!payload.success) return err('VALIDATION_ERROR', 'productId is required.');
      const result = await unlinkProduct(payload.data.productId, {
        now: new Date().toISOString(),
        userId: admin.data.userId,
      });
      if (!result.ok) return err('NOT_FOUND', 'Product not found.');
      return ok(result);
    }
    case 'setAlibabaPrimaryOffer': {
      // ARCHITECTURE §5 rule 1 / MIU_BREAKDOWN R1 L4: the operator pin's only
      // write path — the field is readOnly in generic CRUD.
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const payload = pinOfferSchema.safeParse(parsed.data.data);
      if (!payload.success) {
        return err('VALIDATION_ERROR', 'productId is required; offerKey may be empty to clear.');
      }
      const result = await setPinnedOffer({
        productId: payload.data.productId,
        offerKey: payload.data.offerKey,
        now: new Date().toISOString(),
      });
      if (!result.ok) {
        return err(
          result.reason === 'product-not-found' || result.reason === 'offer-not-found'
            ? 'NOT_FOUND'
            : 'CONFLICT',
          `Pin rejected: ${result.reason}.`,
        );
      }
      return ok(result);
    }
    case 'runNow': {
      // Manual run (MIU 11): a SHORT bounded slice executes inline — the
      // gateway envelope stays interactive; the test env has no timer, so
      // repeated runNow calls drive continuations to completion there.
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const runtime = resolveRuntime(config, runtimeOverrides);
      if (!runtime.ok) {
        return err('CONFLICT', NOT_CONFIGURED_MESSAGE + runtime.missing.join(', '));
      }
      // READ-ONLY health probe first (review R2-verify #4): the runner short
      // circuits to 'idle' when nothing is due, which would report a dead
      // credential as a success. The probe never refreshes, so it cannot race
      // the rotating refresh token outside the lease.
      const health = await probeConnection(runtime.runtime.deps);
      if (!health.ok) {
        return err('CONFLICT', `Alibaba connection unavailable: ${health.reason}.`);
      }
      const report = await runSyncTick({
        deps: {
          client: runtime.runtime.deps.client,
          // Resolved inside the runner AFTER the lease (review R2 #3).
          getAccessToken: () => getConnectionAccessToken(runtime.runtime.deps),
          now: runtime.runtime.deps.now,
          alert: runtime.runtime.deps.alert,
        },
        trigger: 'manual',
        budgetOverrides: { softDeadlineMs: 15_000, maxProducts: 20, maxApiCalls: 10 },
      });
      if (report.outcome === 'not-connected') {
        return err('CONFLICT', `Alibaba connection unavailable: ${report.detail ?? 'unknown'}.`);
      }
      return ok(report);
    }
    case 'inspectProductDetail': {
      // Admin-only, read-only live contract probe: the exact TOP response is
      // stored privately, while the response exposes structure only. This is
      // intentionally not a shortcut around the runner-owned mirror writes.
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const payload = inspectProductSchema.safeParse(parsed.data.data);
      if (!payload.success) {
        return err('VALIDATION_ERROR', 'A valid Alibaba sourceProductId is required.');
      }
      const runtime = resolveRuntime(config, runtimeOverrides);
      if (!runtime.ok) {
        return err('CONFLICT', NOT_CONFIGURED_MESSAGE + runtime.missing.join(', '));
      }
      const result = await inspectAlibabaProductDetail({
        sourceProductId: payload.data.sourceProductId,
        deps: {
          client: runtime.runtime.deps.client,
          // Resolved only after the inspection owns the shared sync lease.
          getAccessToken: () => getConnectionAccessToken(runtime.runtime.deps),
          now: runtime.runtime.deps.now,
        },
      });
      if (!result.ok) {
        if (result.reason === 'invalid-product-id') {
          return err('VALIDATION_ERROR', 'A valid Alibaba sourceProductId is required.');
        }
        if (result.reason === 'lease-busy') {
          return err('CONFLICT', 'An Alibaba sync operation is already active.');
        }
        if (result.reason === 'not-connected') {
          return err('CONFLICT', 'The Alibaba connection is unavailable.');
        }
        return err('INTERNAL_ERROR', `Alibaba detail inspection failed: ${result.reason}.`);
      }
      return ok(result.summary);
    }
    case 'replaySourceObservations': {
      // Admin-only migration surface. Dry-run and apply read the same bounded
      // raw page; apply is impossible without the matching dry-run hash.
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const payload = rawReplaySchema.safeParse(parsed.data.data);
      if (!payload.success) {
        return err(
          'VALIDATION_ERROR',
          'mode, cursor, page limit, dry-run hash, source total or replay manifest is invalid.',
        );
      }
      const result = await replayAlibabaRawPage({
        mode: payload.data.mode,
        ...(payload.data.afterSourceKey === undefined
          ? {}
          : { afterSourceKey: payload.data.afterSourceKey }),
        ...(payload.data.limit === undefined ? {} : { limit: payload.data.limit }),
        ...(payload.data.expectedPageHash === undefined
          ? {}
          : { expectedPageHash: payload.data.expectedPageHash }),
        ...(payload.data.expectedTotalSourceProducts === undefined
          ? {}
          : { expectedTotalSourceProducts: payload.data.expectedTotalSourceProducts }),
        ...(payload.data.manifestId === undefined ? {} : { manifestId: payload.data.manifestId }),
        requestedBy: admin.data.userId,
      });
      if (!result.ok) {
        switch (result.reason) {
          case 'invalid-input':
            return err('VALIDATION_ERROR', 'Raw replay input is invalid.');
          case 'lease-busy':
          case 'lease-lost':
          case 'page-changed':
          case 'manifest-invalid':
            return err('CONFLICT', `Raw replay stopped: ${result.reason}.`);
          case 'lease-corrupt':
            return err('INTERNAL_ERROR', 'Raw replay lease state is corrupt.');
        }
      }
      return ok(result);
    }
    case 'approveQuarantine': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const payload = approveSchema.safeParse(parsed.data.data);
      if (!payload.success) {
        return err('VALIDATION_ERROR', 'runId and candidateHash are required.');
      }
      const runtime = resolveRuntime(config, runtimeOverrides);
      if (!runtime.ok) {
        return err('CONFLICT', NOT_CONFIGURED_MESSAGE + runtime.missing.join(', '));
      }
      const result = await approveQuarantinedRun({
        runId: payload.data.runId,
        candidateHash: payload.data.candidateHash,
        approvedByUserId: admin.data.userId,
        now: runtime.runtime.deps.now,
        alert: runtime.runtime.deps.alert,
      });
      if (!result.ok) {
        return err(
          result.reason === 'superseded' ? 'CONFLICT' : 'NOT_FOUND',
          `Quarantine approval failed: ${result.reason}.`,
        );
      }
      return ok(result);
    }
    case 'importSourceImage': {
      // Candidate-only import (MIU 12): fetches ONE allowlisted source image
      // through the SSRF pipeline; never attaches it to a product.
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const payload = importImageSchema.safeParse(parsed.data.data);
      if (!payload.success) return err('VALIDATION_ERROR', 'url is required.');
      const result = await importCandidateImage(payload.data.url);
      if (!result.ok) return err('VALIDATION_ERROR', `Import rejected: ${result.reason}.`);
      return ok(result);
    }
    case 'removeImportedImage': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const payload = removeImageSchema.safeParse(parsed.data.data);
      if (!payload.success) return err('VALIDATION_ERROR', 'imageId is required.');
      const result = await removeImportedCandidate(payload.data.imageId);
      if (!result.ok) {
        const code =
          result.reason === 'not-found'
            ? 'NOT_FOUND'
            : result.reason === 'delete-failed'
              ? 'INTERNAL_ERROR'
              : 'CONFLICT';
        return err(code, `Removal rejected: ${result.reason}.`);
      }
      return ok(result);
    }
    default:
      return err('BAD_REQUEST', `Unknown action: ${action}`);
  }
}

const linkSchema = z.object({ sourceKey: z.string().min(1), productId: z.string().min(1) });
const unlinkSchema = z.object({ productId: z.string().min(1) });
// An EMPTY offerKey clears the pin, so min(1) would make the pin one-way.
const pinOfferSchema = z.object({
  productId: z.string().min(1),
  offerKey: z.string(),
});
const approveSchema = z.object({ runId: z.string().min(1), candidateHash: z.string().min(1) });
const inspectProductSchema = z.object({
  sourceProductId: z.string().trim().refine(isAlibabaProductId),
});
const rawReplaySchema = z
  .object({
    mode: z.enum(['dry-run', 'apply']),
    afterSourceKey: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    expectedPageHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    expectedTotalSourceProducts: z.number().int().nonnegative().optional(),
    manifestId: z
      .string()
      .regex(/^raw-replay-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'apply') {
      if (value.expectedPageHash === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expectedPageHash'],
          message: 'Apply requires the corresponding dry-run page hash.',
        });
      }
      if (value.expectedTotalSourceProducts === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expectedTotalSourceProducts'],
          message: 'Apply requires the authoritative dry-run source total.',
        });
      }
      if (value.manifestId === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifestId'],
          message: 'Apply requires a completed server replay manifest.',
        });
      }
    }
  });
const importImageSchema = z.object({ url: z.string().min(1) });
const removeImageSchema = z.object({ imageId: z.string().min(1) });

export type CallbackRedirect = { location: string };

/**
 * GET /oauth/callback — unauthenticated, state-bound, rate-limited. Always
 * finishes with a redirect to the site-origin admin page carrying a coarse
 * status code (never error details, never token material).
 */
export async function handleOAuthCallbackRequest(
  query: { code?: string; state?: string },
  config: AlibabaSyncFunctionConfig,
  context: RequestContext = {},
  runtimeOverrides?: Parameters<typeof resolveRuntime>[1],
): Promise<CallbackRedirect> {
  const site = (config.siteUrl ?? '').replace(/\/$/, '');
  const target = (status: string) => ({ location: `${site}/admin?alibaba=${status}` });

  const nowMs = runtimeOverrides?.now ? Date.parse(runtimeOverrides.now()) : Date.now();
  const denied = await enforceOAuthRateLimit({
    scope: 'alibabaOauthCallback',
    sourceHash: hashSourceIp(context.sourceIp),
    nowMs,
  }).catch((e) => {
    // Ledger failure fails CLOSED for an unauthenticated endpoint.
    console.error('[alibaba-catalog-sync] callback rate-limit check failed:', e);
    return { denied: true as const, retryAfterSeconds: 60 };
  });
  if (denied) return target('rate-limited');

  const runtime = resolveRuntime(config, runtimeOverrides);
  if (!runtime.ok) return target('not-configured');
  const outcome = await handleOAuthCallback(runtime.runtime.deps, query.code, query.state);
  if (outcome.ok) return target('connected');
  return target(`error-${outcome.reason}`);
}
