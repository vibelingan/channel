import { createHash } from 'node:crypto';
import {
  hashCanonicalJson,
  parseStrictJson,
  validateContract,
  ContractValidationError,
} from '@vibelingan-channel/sales-contracts';
import type { TaskReadLease, TaskReadRequest } from '@vibelingan-channel/sales-contracts';
import type { AccessGrant } from '@vibelingan-channel/sales-contracts/access';
import {
  authorizeTaskRead,
  TaskAccessDenied,
} from '@vibelingan-channel/sales-contracts/task-access';
import { z } from 'zod';
import { InquiryStatusSchema, isTerminalInquiry } from '@vibelingan-channel/shared/catalog-inquiry';
import type { SalesDependencies } from './handler.ts';
import { readInquiry, SalesSourceError } from './sources.ts';

export interface TaskGateDependencies {
  now(): number;
  loadLease(hash: string): Promise<unknown>;
  loadHandoff(hash: string): Promise<unknown>;
  loadInstallation(): Promise<unknown>;
  fetchPermit(request: TaskReadRequest): Promise<unknown>;
}
export type ReadTarget = {
  action: TaskReadRequest['action'];
  resource: unknown;
};
const contextSchema = z
  .object({
    protocol: z.literal('sales-auth/1'),
    task_id: z.string(),
    run_id: z.string(),
    task_revision: z.number().int().nonnegative().safe(),
    request_id: z.string(),
  })
  .strict();
const installationSchema = z
  .object({
    client_id: z.string(),
    business_line: z.string(),
    source_installation_id: z.string(),
    environment: z.enum(['test', 'production']),
    cloud_env_id: z.string(),
    state: z.literal('active'),
  })
  .strict();

export class SalesTaskGate {
  constructor(private readonly deps: SalesDependencies) {}

  async execute<T>(
    grant: AccessGrant,
    headers: Record<string, string>,
    target: ReadTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    const token = headers['x-sales-lease'] ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TaskAccessDenied();
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.byteLength !== 32 || bytes.toString('base64url') !== token)
      throw new TaskAccessDenied();
    const hash = createHash('sha256').update(bytes).digest('hex');
    let context: z.infer<typeof contextSchema>;
    try {
      const encoded = headers['x-sales-task'] ?? '';
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) throw new TaskAccessDenied();
      const raw = Buffer.from(encoded, 'base64url');
      if (raw.toString('base64url') !== encoded) throw new TaskAccessDenied();
      context = contextSchema.parse(
        parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
      );
    } catch {
      throw new TaskAccessDenied();
    }
    const load = async () => {
      const gate = this.deps.taskAccess;
      const installation = installationSchema.parse(await gate.loadInstallation());
      if (
        installation.client_id !== this.deps.client_id ||
        installation.business_line !== this.deps.business_line ||
        installation.source_installation_id !== this.deps.installation_id ||
        installation.environment !== this.deps.environment ||
        installation.cloud_env_id !== this.deps.cloud_env_id
      )
        throw new TaskAccessDenied();
      const lease = validateContract('sales-auth-lease', await gate.loadLease(hash));
      const handoff = validateContract(
        'sales-auth-handoff',
        await gate.loadHandoff(lease.handoff_sha256),
      );
      return {
        lease,
        handoff,
        installation,
        fingerprint: hashCanonicalJson({ lease, handoff, installation }),
      };
    };
    const check = async () => {
      try {
        const gate = this.deps.taskAccess;
        const before = await load();
        const lease = before.lease;
        const request = validateContract('sales-auth-request', {
          ...context,
          ...target,
          connection_id: grant.connection_id,
          lease_sha256: hash,
          client_id: grant.client_id,
          business_line: grant.business_line,
          source_installation_id: grant.source_installation_id,
          runtime_id: grant.runtime_id,
          environment: grant.environment,
          control_epoch: grant.control_epoch,
          handoff_sha256: lease.handoff_sha256,
        });
        const permit = await gate.fetchPermit(request);
        const after = await load();
        if (after.fingerprint !== before.fingerprint) throw new TaskAccessDenied();
        authorizeTaskRead(after.lease, after.handoff, permit, request, gate.now());
        return { lease: after.lease, fingerprint: after.fingerprint };
      } catch (error) {
        if (error instanceof ContractValidationError || error instanceof z.ZodError)
          throw new TaskAccessDenied();
        throw error;
      }
    };
    const before = await check();
    await this.verifySource(before.lease);
    const result = await operation();
    await this.verifySource(before.lease);
    const after = await check();
    if (after.fingerprint !== before.fingerprint) throw new TaskAccessDenied();
    return result;
  }

  private async verifySource(lease: TaskReadLease): Promise<void> {
    const source = await readInquiry(this.deps, lease.source.kind, lease.source.id);
    const terminal =
      lease.source.kind === 'product'
        ? isTerminalInquiry(InquiryStatusSchema.parse(source.view.record_status))
        : source.view.record_status === 'closed';
    if (terminal) throw new TaskAccessDenied();
    if (source.view.source_revision !== lease.source.revision)
      throw new SalesSourceError(409, 'SOURCE_CHANGED');
    if (lease.asset_refs.some((ref) => !source.view.assets.some((asset) => asset.ref === ref)))
      throw new TaskAccessDenied();
    if (lease.source.kind === 'oem') {
      const row = await this.deps.readDoc('oemProjects', lease.source.id);
      if (
        !row ||
        row.salesSubmissionState !== 'finalized' ||
        row.salesSubmittedRevision !== lease.source.revision
      )
        throw new TaskAccessDenied();
    }
  }
}
