import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashCanonicalJson, validateContract } from '@vibelingan-channel/sales-contracts';
import {
  SalesAccessController,
  type AccessScope,
} from '@vibelingan-channel/sales-contracts/access';
import {
  SourceRegistrationSchema,
  registrationKey,
  type SalesCaptureScope,
  type SourceRegistration,
} from '@vibelingan-channel/db/sales-inquiry-submission';
import {
  canonicalInquiryEvent,
  readSalesInquiry,
} from '@vibelingan-channel/db/sales-inquiry-source';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { InquiryStatusSchema, isTerminalInquiry } from '@vibelingan-channel/shared/catalog-inquiry';
import { parseIntakeReceipt, type IntakeReceipt, type InquirySender } from './inquiry-sender.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const seconds = z.number().int().nonnegative().safe();
const ownerShape = {
  client_id: id,
  business_line: id,
  source_installation_id: id,
  environment: z.enum(['test', 'production']),
};
const base = z.object({
  schema_version: z.literal('1'),
  ...ownerShape,
  registration_key: hash,
  registration_sha256: hash,
  attempt: z.number().int().nonnegative().safe(),
});
const receipt = z
  .object({
    task_id: z.number().int().positive().safe(),
    run_id: z.string().regex(/^[a-f0-9]{32}$/),
    state: z.literal('queued'),
  })
  .strict();
const stateSchema = z.discriminatedUnion('status', [
  base
    .extend({
      status: z.literal('pending'),
      attempt: z.literal(0),
      lease_id: z.null(),
      lease_until: z.literal(0),
      next_attempt_at: z.literal(0),
      receipt: z.null(),
    })
    .strict(),
  base
    .extend({
      status: z.literal('inflight'),
      attempt: z.number().int().positive().safe(),
      lease_id: z.string().regex(/^[a-f0-9]{32}$/),
      lease_until: seconds,
      next_attempt_at: z.literal(0),
      receipt: z.null(),
    })
    .strict(),
  base
    .extend({
      status: z.literal('retry'),
      attempt: z.number().int().positive().safe(),
      lease_id: z.null(),
      lease_until: z.literal(0),
      next_attempt_at: seconds,
      receipt: z.null(),
    })
    .strict(),
  base
    .extend({
      status: z.literal('accepted'),
      attempt: z.number().int().positive().safe(),
      lease_id: z.null(),
      lease_until: z.literal(0),
      next_attempt_at: z.literal(0),
      receipt,
    })
    .strict(),
]);
export type SourceDeliveryState = z.infer<typeof stateSchema>;
export type DeliveryOwner = Pick<
  SalesCaptureScope,
  'client_id' | 'business_line' | 'source_installation_id' | 'environment'
>;
export type DeliveryCollection =
  | 'channelSalesSourceRegistrations'
  | 'channelSalesSourceDeliveries'
  | 'channelSalesDeliveryCursors'
  | 'channelSalesBindings'
  | 'channelSalesInstallations'
  | 'oemProjects'
  | 'catalogQuoteRequests'
  | 'files';
export interface DeliveryTransaction {
  read(collection: DeliveryCollection, id: string): Promise<unknown>;
  write(
    collection: 'channelSalesSourceDeliveries' | 'channelSalesDeliveryCursors',
    id: string,
    value: Record<string, unknown>,
  ): Promise<void>;
}
export interface DeliveryStore {
  transaction<T>(operation: (tx: DeliveryTransaction) => Promise<T>): Promise<T>;
  scan(
    owner: DeliveryOwner,
    after: string | null,
    limit: number,
  ): Promise<Array<{ key: string; record: unknown }>>;
}
export interface WebsiteDeliveryOptions {
  enabled: boolean;
  scope: SalesCaptureScope & Pick<AccessScope, 'runtime_id' | 'control_epoch'>;
  connection_id: string;
  source_token: string;
  store: DeliveryStore;
  sender: InquirySender;
  loadCredential(ref: string): Promise<string | undefined>;
  now(): number;
}
export type DeliveryOutcome = {
  key: string;
  state: 'accepted' | 'already_accepted' | 'retry' | 'busy' | 'rejected';
  receipt?: IntakeReceipt;
};
function field(row: unknown, name: string): unknown {
  return row && typeof row === 'object' && !Array.isArray(row) && Object.hasOwn(row, name)
    ? Reflect.get(row, name)
    : undefined;
}
function same(a: unknown, b: unknown): boolean {
  return hashCanonicalJson(a) === hashCanonicalJson(b);
}
function ownerOf(scope: DeliveryOwner): DeliveryOwner {
  return {
    client_id: scope.client_id,
    business_line: scope.business_line,
    source_installation_id: scope.source_installation_id,
    environment: scope.environment,
  };
}
function timestamp(clock: () => number): number {
  return seconds.max(Number.MAX_SAFE_INTEGER - 300).parse(clock());
}

/** A host-only, bounded worker. Registration facts and delivery attempts stay separate. */
export class WebsiteDelivery {
  private readonly owner: DeliveryOwner;
  private readonly cursorKey: string;
  constructor(private readonly options: WebsiteDeliveryOptions) {
    this.owner = z.object(ownerShape).strict().parse(ownerOf(options.scope));
    seconds.parse(options.scope.cutover_at);
    id.parse(options.scope.runtime_id);
    id.parse(options.connection_id);
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(options.source_token))
      throw new Error('Invalid source credential');
    seconds.parse(options.scope.control_epoch);
    if (!options.scope.cloud_env_id) throw new Error('Missing Sales cloud environment');
    this.cursorKey = hashCanonicalJson(this.owner);
  }
  private async checked(
    tx: DeliveryTransaction,
    key: string,
  ): Promise<{ registration: SourceRegistration; bindingHash: string }> {
    const registration = SourceRegistrationSchema.parse(
      field(await tx.read('channelSalesSourceRegistrations', key), 'record'),
    );
    const scope = this.options.scope;
    const now = timestamp(this.options.now);
    if (
      !same(ownerOf(registration), this.owner) ||
      registrationKey(registration) !== key ||
      registration.cutover_at !== scope.cutover_at ||
      registration.registered_at < scope.cutover_at ||
      registration.registered_at > now ||
      Math.floor(Date.parse(registration.event.submitted_at) / 1000) < scope.cutover_at
    )
      throw new Error('Untrusted source registration');
    const installation = field(
      await tx.read('channelSalesInstallations', scope.source_installation_id),
      'record',
    );
    if (!same(installation, { ...this.owner, cloud_env_id: scope.cloud_env_id, state: 'active' }))
      throw new Error('Source installation unavailable');
    const registry = validateContract(
      'client-bindings',
      field(await tx.read('channelSalesBindings', scope.source_installation_id), 'registry'),
    );
    const binding = registry.bindings.find(
      (row) => row.client_id === scope.client_id && row.environment === scope.environment,
    );
    const connection = binding?.connections.find(
      (row) => row.connection_id === this.options.connection_id,
    );
    if (
      !binding ||
      !connection ||
      connection.actor.kind !== 'runtime' ||
      connection.actor.id !== scope.runtime_id
    )
      throw new Error('Source delivery connection unavailable');
    for (const row of registry.bindings)
      for (const candidate of row.connections) {
        if (
          (await this.options.loadCredential(candidate.credential_ref)) ===
          this.options.source_token
        )
          throw new Error('Source credential reused');
      }
    const token = await this.options.loadCredential(connection.credential_ref);
    const access = new SalesAccessController({
      loadRegistry: async () =>
        field(await tx.read('channelSalesBindings', scope.source_installation_id), 'registry'),
      loadCredential: this.options.loadCredential,
    });
    await access.execute(
      {
        scope: { ...this.owner, runtime_id: scope.runtime_id, control_epoch: scope.control_epoch },
        connection_id: this.options.connection_id,
        bearer_token: token ?? '',
        action: 'inquiry.read',
      },
      async () => undefined,
    );
    const readDoc = async (
      collection: 'oemProjects' | 'catalogQuoteRequests' | 'files',
      recordId: string,
    ): Promise<CollectionDoc | null> => {
      const row = await tx.read(collection, recordId);
      if (row === null) return null;
      if (!row || typeof row !== 'object' || Array.isArray(row) || field(row, '_id') !== recordId)
        throw new Error('Malformed source row');
      return row as CollectionDoc;
    };
    const original = await readDoc(
      registration.source.kind === 'oem' ? 'oemProjects' : 'catalogQuoteRequests',
      registration.source.id,
    );
    if (
      !original ||
      original.salesSubmissionState !== 'finalized' ||
      original.salesSubmittedRevision !== registration.source.revision
    )
      throw new Error('Source submission incomplete');
    const { view } = await readSalesInquiry(
      { ...scope, readDoc },
      registration.source.kind,
      registration.source.id,
    );
    const event = canonicalInquiryEvent(this.owner, view);
    const terminal =
      view.kind === 'product'
        ? isTerminalInquiry(InquiryStatusSchema.parse(view.record_status))
        : view.record_status === 'closed';
    if (
      terminal ||
      !same(event, registration.event) ||
      view.source_revision !== registration.source.revision
    )
      throw new Error('Source registration changed');
    return { registration, bindingHash: hashCanonicalJson(binding) };
  }
  private state(row: unknown, key: string, digest: string): SourceDeliveryState | null {
    if (row === null) return null;
    const state = stateSchema.parse(field(row, 'record'));
    if (
      !same(ownerOf(state), this.owner) ||
      state.registration_key !== key ||
      state.registration_sha256 !== digest
    )
      throw new Error('Wrong delivery identity');
    return state;
  }
  async deliver(key: string): Promise<DeliveryOutcome> {
    hash.parse(key);
    if (!this.options.enabled) return { key, state: 'rejected' };
    const leaseId = randomBytes(16).toString('hex');
    let claim: {
      registration: SourceRegistration;
      bindingHash: string;
      state: SourceDeliveryState;
    };
    try {
      const result = await this.options.store.transaction(async (tx) => {
        const checked = await this.checked(tx, key);
        const digest = hashCanonicalJson(checked.registration);
        const prior = this.state(await tx.read('channelSalesSourceDeliveries', key), key, digest);
        const now = timestamp(this.options.now);
        if (!prior) throw new Error('Source delivery was not registered atomically');
        if (prior.status === 'accepted')
          return {
            kind: 'outcome' as const,
            outcome: { key, state: 'already_accepted' as const, receipt: prior.receipt },
          };
        if (
          (prior.status === 'inflight' && prior.lease_until > now) ||
          (prior.status === 'retry' && prior.next_attempt_at > now)
        )
          return { kind: 'outcome' as const, outcome: { key, state: 'busy' as const } };
        const state: SourceDeliveryState = stateSchema.parse({
          schema_version: '1',
          ...this.owner,
          registration_key: key,
          registration_sha256: digest,
          status: 'inflight',
          attempt: prior.attempt + 1,
          lease_id: leaseId,
          lease_until: now + 30,
          next_attempt_at: 0,
          receipt: null,
        });
        await tx.write('channelSalesSourceDeliveries', key, { record: state });
        return { kind: 'claim' as const, claim: { ...checked, state } };
      });
      if (result.kind === 'outcome') return result.outcome;
      claim = result.claim;
    } catch {
      return { key, state: 'rejected' };
    }
    try {
      const accepted = parseIntakeReceipt(await this.options.sender.send(claim.registration.event));
      await this.options.store.transaction(async (tx) => {
        const checked = await this.checked(tx, key);
        const current = this.state(
          await tx.read('channelSalesSourceDeliveries', key),
          key,
          claim.state.registration_sha256,
        );
        if (
          !current ||
          current.status !== 'inflight' ||
          current.lease_id !== leaseId ||
          current.lease_until <= timestamp(this.options.now) ||
          checked.bindingHash !== claim.bindingHash ||
          !same(checked.registration, claim.registration)
        )
          throw new Error('Delivery attempt lost');
        await tx.write('channelSalesSourceDeliveries', key, {
          record: {
            ...current,
            status: 'accepted',
            lease_id: null,
            lease_until: 0,
            next_attempt_at: 0,
            receipt: accepted,
          },
        });
      });
      return { key, state: 'accepted', receipt: accepted };
    } catch {
      try {
        const saved = await this.options.store.transaction(async (tx) => {
          const current = this.state(
            await tx.read('channelSalesSourceDeliveries', key),
            key,
            claim.state.registration_sha256,
          );
          const now = timestamp(this.options.now);
          if (
            !current ||
            current.status !== 'inflight' ||
            current.lease_id !== leaseId ||
            current.lease_until <= now
          )
            return false;
          await tx.write('channelSalesSourceDeliveries', key, {
            record: {
              ...current,
              status: 'retry',
              lease_id: null,
              lease_until: 0,
              next_attempt_at: now + Math.min(300, 2 ** Math.min(8, current.attempt)),
              receipt: null,
            },
          });
          return true;
        });
        return { key, state: saved ? 'retry' : 'busy' };
      } catch {
        throw new Error('Delivery outcome could not be recorded');
      }
    }
  }
  async tick(
    limit = 20,
  ): Promise<{ state: 'disabled' | 'scanned'; wrapped: boolean; results: DeliveryOutcome[] }> {
    if (!this.options.enabled) return { state: 'disabled', wrapped: false, results: [] };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new Error('Invalid delivery batch size');
    const cursorSchema = z
      .object({ schema_version: z.literal('1'), ...ownerShape, after: hash.nullable() })
      .strict();
    const after = await this.options.store.transaction(async (tx) => {
      const row = await tx.read('channelSalesDeliveryCursors', this.cursorKey);
      if (row === null) return null;
      const cursor = cursorSchema.parse(field(row, 'record'));
      if (!same(ownerOf(cursor), this.owner)) throw new Error('Wrong scan cursor owner');
      return cursor.after;
    });
    const rows = await this.options.store.scan(this.owner, after, limit);
    if (
      rows.length > limit ||
      rows.some(
        (row, i) =>
          !hash.safeParse(row.key).success ||
          (i > 0 && (rows[i - 1]?.key ?? '') >= row.key) ||
          (after !== null && row.key <= after),
      )
    )
      throw new Error('Invalid source scan ordering');
    const results: DeliveryOutcome[] = [];
    let previous = after;
    for (const row of rows) {
      results.push(await this.deliver(row.key));
      await this.options.store.transaction(async (tx) => {
        const raw = await tx.read('channelSalesDeliveryCursors', this.cursorKey);
        const cursor = raw === null ? null : cursorSchema.parse(field(raw, 'record'));
        if (cursor && !same(ownerOf(cursor), this.owner))
          throw new Error('Wrong scan cursor owner');
        if ((cursor?.after ?? null) !== previous) return;
        await tx.write('channelSalesDeliveryCursors', this.cursorKey, {
          record: { schema_version: '1', ...this.owner, after: row.key },
        });
      });
      previous = row.key;
    }
    if (!rows.length) {
      await this.options.store.transaction(async (tx) => {
        const raw = await tx.read('channelSalesDeliveryCursors', this.cursorKey);
        const cursor = raw === null ? null : cursorSchema.parse(field(raw, 'record'));
        if (cursor && !same(ownerOf(cursor), this.owner))
          throw new Error('Wrong scan cursor owner');
        if ((cursor?.after ?? null) === after)
          await tx.write('channelSalesDeliveryCursors', this.cursorKey, {
            record: { schema_version: '1', ...this.owner, after: null },
          });
      });
    }
    return { state: 'scanned', wrapped: rows.length === 0, results };
  }
}
