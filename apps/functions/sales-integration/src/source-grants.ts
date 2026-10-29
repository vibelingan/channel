import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  hashCanonicalJson,
  validateContract,
  type InquirySubmitted,
  type SourceHandoff,
  type TaskReadLease,
} from '@vibelingan-channel/sales-contracts';
import { SalesAccessController } from '@vibelingan-channel/sales-contracts/access';
import { InquiryStatusSchema, isTerminalInquiry } from '@vibelingan-channel/shared/catalog-inquiry';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import type { SalesDependencies } from './handler.ts';
import { canonicalInquiryEvent } from './canonical-source-event.ts';
import { readInquiry, SalesSourceError } from './sources.ts';

export type SourceGrantCollection =
  | 'oemProjects'
  | 'catalogQuoteRequests'
  | 'files'
  | 'channelSalesBindings'
  | 'channelSalesInstallations'
  | 'channelSalesSourceHandoffs'
  | 'channelSalesTaskLeases'
  | 'channelSalesSourceGrantRequests';
export interface SourceGrantTransaction {
  read(collection: SourceGrantCollection, id: string): Promise<unknown>;
  write(
    collection: SourceGrantCollection,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void>;
}
export interface SourceGrantStore {
  transaction<T>(operation: (tx: SourceGrantTransaction) => Promise<T>): Promise<T>;
}
export interface SourceGrantDependencies {
  enabled: boolean;
  token: string;
  forbiddenTokens: readonly string[];
  store: SourceGrantStore;
  now(): number;
}
export class SourceGrantError extends Error {
  constructor(
    readonly status: 400 | 403 | 409,
    readonly code: string,
  ) {
    super(code);
  }
}
function denied(): never {
  throw new SourceGrantError(403, 'FORBIDDEN');
}
function conflict(): never {
  throw new SourceGrantError(409, 'GRANT_CONFLICT');
}
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z
  .object({
    protocol: z.literal('sales-auth/1'),
    request_id: z.string().regex(/^[a-f0-9]{32}$/),
    client_id: id,
    business_line: id,
    source_installation_id: id,
    environment: z.enum(['test', 'production']),
    runtime_id: id,
    control_epoch: z.number().int().nonnegative().safe(),
    task_id: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .refine((value) => Number(value) <= Number.MAX_SAFE_INTEGER),
    run_id: z.string().regex(/^[a-f0-9]{32}$/),
    task_revision: z.number().int().positive().safe(),
    connection_id: id,
    lease_sha256: hash,
    event: z.unknown(),
  })
  .strict();
const installationSchema = z
  .object({
    client_id: id,
    business_line: id,
    source_installation_id: id,
    environment: z.enum(['test', 'production']),
    cloud_env_id: z.string().min(1),
    state: z.literal('active'),
  })
  .strict();
const metadataSchema = z.object({ fingerprint: hash, response: z.unknown() }).strict();
const claimSchema = z
  .object({ request_id: z.string().regex(/^[a-f0-9]{32}$/), fingerprint: hash })
  .strict();
const recordSchema = z
  .object({
    _id: z.string(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();
export interface SourceGrantResponse {
  protocol: 'sales-auth/1';
  request_id: string;
  handoff: SourceHandoff;
  lease: TaskReadLease;
}
function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}
async function existingRecord(
  tx: SourceGrantTransaction,
  collection: SourceGrantCollection,
  key: string,
): Promise<unknown> {
  const row = await tx.read(collection, key);
  if (row === null) return undefined;
  const record = field(row, 'record');
  if (record === undefined) denied();
  return record;
}
const equal = (left: unknown, right: unknown) =>
  hashCanonicalJson(left) === hashCanonicalJson(right);
const secretHash = (token: string) => createHash('sha256').update(token, 'utf8').digest();
const validSecret = (token: string) => /^[A-Za-z0-9_-]{32,512}$/.test(token);

export function sourceGrantTokenMatches(
  config: SourceGrantDependencies,
  presented: string,
): boolean {
  return (
    validSecret(config.token) &&
    validSecret(presented) &&
    timingSafeEqual(secretHash(config.token), secretHash(presented))
  );
}

/** Issues authority only after all source and registry reads in the same transaction. */
export async function issueSourceGrant(
  deps: SalesDependencies,
  input: unknown,
): Promise<SourceGrantResponse> {
  const config = deps.sourceGrants;
  if (!config?.enabled) denied();
  let request: z.infer<typeof requestSchema>;
  let event: InquirySubmitted;
  try {
    request = requestSchema.parse(input);
    event = validateContract('inquiry', request.event);
  } catch {
    throw new SourceGrantError(400, 'INVALID_REQUEST');
  }
  const owner = {
    client_id: deps.client_id,
    business_line: deps.business_line,
    source_installation_id: deps.installation_id,
  };
  if (
    request.client_id !== owner.client_id ||
    request.business_line !== owner.business_line ||
    request.source_installation_id !== owner.source_installation_id ||
    request.environment !== deps.environment ||
    !validSecret(config.token) ||
    config.forbiddenTokens.some((token) => token === config.token)
  )
    denied();
  const fingerprint = hashCanonicalJson(request);
  const requestKey = hashCanonicalJson({
    ...owner,
    environment: deps.environment,
    request_id: request.request_id,
  });
  const claimKey = hashCanonicalJson({ lease_sha256: request.lease_sha256 });

  return config.store.transaction(async (tx) => {
    const now = config.now();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 300)) denied();
    let registry;
    let installation;
    try {
      registry = validateContract(
        'client-bindings',
        field(await tx.read('channelSalesBindings', deps.installation_id), 'registry'),
      );
      installation = installationSchema.parse(
        field(await tx.read('channelSalesInstallations', deps.installation_id), 'record'),
      );
    } catch {
      return denied();
    }
    if (
      !equal(installation, {
        ...owner,
        environment: deps.environment,
        cloud_env_id: deps.cloud_env_id,
        state: 'active',
      })
    )
      denied();
    const binding = registry.bindings.find(
      (row) => row.client_id === owner.client_id && row.environment === deps.environment,
    );
    const runtimeConnections = binding?.connections.filter(
      (row) => row.active && row.actor.kind === 'runtime' && row.actor.id === binding.runtime_id,
    );
    const connection = runtimeConnections?.[0];
    if (
      !binding ||
      !connection ||
      runtimeConnections?.length !== 1 ||
      connection.connection_id !== request.connection_id ||
      binding.runtime_id !== request.runtime_id ||
      !connection.actions.includes('inquiry.read') ||
      !connection.actions.includes('product.read')
    )
      denied();
    // Distinct host credentials are checked against every registered connection, not model text.
    for (const row of registry.bindings)
      for (const candidate of row.connections) {
        const token = await deps.loadCredential(candidate.credential_ref);
        if (token === config.token) denied();
      }
    const runtimeToken = await deps.loadCredential(connection.credential_ref);
    if (!runtimeToken) denied();
    const access = new SalesAccessController({
      loadRegistry: async () =>
        field(await tx.read('channelSalesBindings', deps.installation_id), 'registry'),
      loadCredential: deps.loadCredential,
    });
    const scope = {
      ...owner,
      environment: deps.environment,
      runtime_id: request.runtime_id,
      control_epoch: request.control_epoch,
    };
    await access.execute(
      {
        scope,
        connection_id: connection.connection_id,
        bearer_token: runtimeToken,
        action: 'inquiry.read',
      },
      async () => undefined,
    );
    await access.execute(
      {
        scope,
        connection_id: connection.connection_id,
        bearer_token: runtimeToken,
        action: 'product.read',
      },
      async () => undefined,
    );
    const readDoc: SalesDependencies['readDoc'] = async (collection, sourceId) => {
      const raw = await tx.read(collection, sourceId);
      if (raw === null) return null;
      const parsed = recordSchema.safeParse(raw);
      return parsed.success ? (parsed.data as CollectionDoc) : denied();
    };
    const kind =
      event.source === 'website_oem'
        ? 'oem'
        : event.source === 'website_product'
          ? 'product'
          : denied();
    let source;
    try {
      source = (await readInquiry({ ...deps, readDoc }, kind, event.source_record_id)).view;
    } catch (error) {
      if (error instanceof SalesSourceError || error instanceof z.ZodError) return denied();
      throw error;
    }
    if (
      kind === 'product'
        ? isTerminalInquiry(InquiryStatusSchema.parse(source.record_status))
        : source.record_status === 'closed'
    )
      denied();
    if (kind === 'oem') {
      const raw = await readDoc('oemProjects', event.source_record_id);
      if (
        raw?.salesSubmissionState !== 'finalized' ||
        raw.salesSubmittedRevision !== source.source_revision
      )
        denied();
    }
    const canonical = canonicalInquiryEvent(owner, source);
    const { event_id: _incomingId, ...incomingFacts } = event;
    const { event_id: _canonicalId, ...sourceFacts } = canonical;
    if (!equal(incomingFacts, sourceFacts)) denied();
    const sourceRef = {
      kind,
      id: source.source_record_id,
      revision: source.source_revision,
    };
    const handoffHash = hashCanonicalJson({
      ...owner,
      environment: deps.environment,
      source: sourceRef,
    });
    const previousHandoff = await existingRecord(tx, 'channelSalesSourceHandoffs', handoffHash);
    const previousLease = await existingRecord(tx, 'channelSalesTaskLeases', request.lease_sha256);
    const previousRequest = await existingRecord(tx, 'channelSalesSourceGrantRequests', requestKey);
    const previousClaim = await existingRecord(tx, 'channelSalesSourceGrantRequests', claimKey);
    let handoff = validateContract('sales-auth-handoff', {
      protocol: 'sales-auth/1',
      ...owner,
      environment: deps.environment,
      handoff_sha256: handoffHash,
      source: sourceRef,
      state: 'ready',
      created_at: now,
    });
    if (previousHandoff !== undefined) {
      try {
        const existing = validateContract('sales-auth-handoff', previousHandoff);
        if (
          existing.created_at > now ||
          existing.state !== 'ready' ||
          !equal(existing, { ...handoff, created_at: existing.created_at })
        )
          denied();
        handoff = existing;
      } catch {
        return denied();
      }
    }
    if (previousRequest !== undefined) {
      const previous = metadataSchema.safeParse(previousRequest);
      const claim = claimSchema.safeParse(previousClaim);
      if (
        !previous.success ||
        !claim.success ||
        previous.data.fingerprint !== fingerprint ||
        claim.data.fingerprint !== fingerprint ||
        claim.data.request_id !== request.request_id
      )
        conflict();
      let lease;
      try {
        lease = validateContract('sales-auth-lease', previousLease);
      } catch {
        return denied();
      }
      const result: SourceGrantResponse = {
        protocol: 'sales-auth/1',
        request_id: request.request_id,
        handoff,
        lease,
      };
      if (
        lease.revoked ||
        lease.expires_at <= now ||
        lease.issued_at > now ||
        !equal(result, previous.data.response)
      )
        denied();
      return result;
    }
    if (previousLease !== undefined || previousClaim !== undefined) conflict();
    const allowed = ['inquiry.read', 'product.read', 'asset.read'] as const;
    const lease = validateContract('sales-auth-lease', {
      protocol: 'sales-auth/1',
      ...scope,
      task_id: request.task_id,
      run_id: request.run_id,
      task_revision: request.task_revision,
      connection_id: connection.connection_id,
      lease_sha256: request.lease_sha256,
      handoff_sha256: handoffHash,
      source: sourceRef,
      asset_refs: source.assets.map((asset) => asset.ref),
      product_scope: 'approved_catalog',
      allowed_actions: allowed.filter((action) => connection.actions.includes(action)),
      audience: 'channel.sales.read',
      issued_at: now,
      expires_at: now + 300,
      revoked: false,
    });
    const result: SourceGrantResponse = {
      protocol: 'sales-auth/1',
      request_id: request.request_id,
      handoff,
      lease,
    };
    // All transaction reads finish before the first write; retries keep the same request identity.
    if (previousHandoff === undefined)
      await tx.write('channelSalesSourceHandoffs', handoffHash, {
        record: handoff,
      });
    await tx.write('channelSalesTaskLeases', request.lease_sha256, {
      record: lease,
    });
    await tx.write('channelSalesSourceGrantRequests', requestKey, {
      record: { fingerprint, response: result },
    });
    await tx.write('channelSalesSourceGrantRequests', claimKey, {
      record: { request_id: request.request_id, fingerprint },
    });
    return result;
  });
}
