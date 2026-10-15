import { createHmac, timingSafeEqual } from 'node:crypto';
import { CATALOG_PREPARATION_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';

const callLifetime = 30_000;
const clockSkew = 5_000;
const leaseLifetime = 120_000;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const callIdentity = z.object({ jobId: hex, nonce: hex }).strict();
const callSchema = callIdentity
  .extend({
    kind: z.literal('catalog-preparation-call-v1'),
    issuedAt: epoch,
    expiresAt: epoch,
    signature: hex,
  })
  .strict();
const leaseSchema = z.object({
  schemaVersion: z.literal('catalog-preparation-job-v1'),
  _id: hex,
  nonce: hex,
  productId: identifier,
  inputDigest: hex,
  contentGeneration: epoch,
  policyVersion: z.literal(CATALOG_PREPARATION_POLICY),
  state: z.literal('running'),
  leaseOwner: identifier,
  leaseVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseExpiresAt: epoch,
});
type Call = z.infer<typeof callSchema>;
type Lease = z.infer<typeof leaseSchema>;
export type CatalogPreparationLeaseScope = Readonly<{
  jobId: string;
  productId: string;
  inputDigest: string;
  contentGeneration: number;
  leaseOwner: string;
  leaseVersion: number;
  capabilities: readonly ['prepare-media', 'store-preparation-report'];
}>;
function objectKey(value: unknown): object | null {
  return typeof value === 'object' && value !== null ? value : null;
}

/** Server-only admission and lease binding; neither grants approval or publication rights. */
export function createCatalogPreparationAuthority(config: {
  secret: string;
  environmentId: string;
  now?: () => number;
}) {
  const { secret, environmentId } = config;
  if (
    typeof secret !== 'string' ||
    secret.length === 0 ||
    typeof environmentId !== 'string' ||
    environmentId.length === 0 ||
    environmentId.trim() !== environmentId
  )
    throw new Error('Invalid preparation authority configuration');
  const clock = config.now ?? Date.now;
  const tickets = new WeakMap<object, Call>();
  const grants = new WeakMap<object, Lease>();
  function time() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid preparation authority clock');
    return value;
  }
  function mac(call: Omit<Call, 'signature'>) {
    return createHmac('sha256', secret)
      .update(
        JSON.stringify([
          'channel/catalog-preparation/admission/v1',
          environmentId,
          call.kind,
          call.jobId,
          call.nonce,
          call.issuedAt,
          call.expiresAt,
        ]),
      )
      .digest();
  }
  function admitted(call: Call, now: number) {
    return (
      call.expiresAt - call.issuedAt === callLifetime &&
      call.issuedAt - now <= clockSkew &&
      call.expiresAt > now
    );
  }
  function activeLease(value: unknown, now: number): Lease | null {
    const parsed = leaseSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.leaseExpiresAt <= now ||
      parsed.data.leaseExpiresAt - now > leaseLifetime + clockSkew
    )
      return null;
    return parsed.data;
  }
  return Object.freeze({
    issueCall(identity: z.infer<typeof callIdentity>): Readonly<Call> {
      const input = callIdentity.parse(identity);
      const issuedAt = time();
      const call = {
        ...input,
        kind: 'catalog-preparation-call-v1' as const,
        issuedAt,
        expiresAt: issuedAt + callLifetime,
      };
      if (!Number.isSafeInteger(call.expiresAt))
        throw new Error('Invalid preparation authority clock');
      return Object.freeze({ ...call, signature: mac(call).toString('hex') });
    },
    verifyCall(value: unknown): object | null {
      const now = time();
      const parsed = callSchema.safeParse(value);
      if (!parsed.success || !admitted(parsed.data, now)) return null;
      const call = parsed.data;
      if (!timingSafeEqual(mac(call), Buffer.from(call.signature, 'hex'))) return null;
      const ticket = Object.freeze({});
      tickets.set(ticket, call);
      return ticket;
    },
    bindLease(ticket: unknown, currentJob: unknown, ownOwner: string): object | null {
      const now = time();
      const key = objectKey(ticket);
      const call = key ? tickets.get(key) : undefined;
      if (!call || !admitted(call, now)) return null;
      const job = activeLease(currentJob, now);
      if (!job || job._id !== call.jobId || job.nonce !== call.nonce || job.leaseOwner !== ownOwner)
        return null;
      const grant = Object.freeze({});
      grants.set(grant, job);
      return grant;
    },
    currentLeaseScope(grant: unknown, freshJob: unknown): CatalogPreparationLeaseScope | null {
      const now = time();
      const key = objectKey(grant);
      const bound = key ? grants.get(key) : undefined;
      if (!bound) return null;
      const job = activeLease(freshJob, now);
      if (
        !job ||
        job._id !== bound._id ||
        job.nonce !== bound.nonce ||
        job.productId !== bound.productId ||
        job.inputDigest !== bound.inputDigest ||
        job.contentGeneration !== bound.contentGeneration ||
        job.leaseOwner !== bound.leaseOwner ||
        job.leaseVersion !== bound.leaseVersion
      )
        return null;
      return Object.freeze({
        jobId: job._id,
        productId: job.productId,
        inputDigest: job.inputDigest,
        contentGeneration: job.contentGeneration,
        leaseOwner: job.leaseOwner,
        leaseVersion: job.leaseVersion,
        capabilities: Object.freeze(['prepare-media', 'store-preparation-report'] as const),
      });
    },
  });
}
