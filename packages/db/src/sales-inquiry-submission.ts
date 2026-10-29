import { z } from 'zod';
import {
  hashCanonicalJson,
  validateContract,
  type InquirySubmitted,
} from '@vibelingan-channel/sales-contracts';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  canonicalInquiryEvent,
  readSalesInquiry,
  type SalesSourceScope,
} from './sales-inquiry-source.ts';
import { assertSalesSdkWrite, normalizeSalesSdkDocument } from './sales-inquiry-read.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/);
const seconds = z.number().int().nonnegative().safe();
export const SalesCaptureScopeSchema = z
  .object({
    client_id: id,
    business_line: id,
    source_installation_id: id,
    environment: z.enum(['test', 'production']),
    cloud_env_id: z.string().min(1),
    cutover_at: seconds,
  })
  .strict();
export type SalesCaptureScope = z.infer<typeof SalesCaptureScopeSchema>;
export function parseSalesCaptureScope(value: unknown): SalesCaptureScope {
  return SalesCaptureScopeSchema.parse(value);
}
export function salesCaptureFromEnv(
  env: Record<string, string | undefined>,
): SalesCaptureScope | undefined {
  if (env.SALES_SOURCE_CAPTURE_ENABLED !== '1') return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(env.SALES_SOURCE_CUTOVER_AT ?? ''))
    throw new Error('Invalid sales source cutover');
  return parseSalesCaptureScope({
    client_id: env.SALES_CLIENT_ID,
    business_line: env.SALES_BUSINESS_LINE,
    source_installation_id: env.SALES_INSTALLATION_ID,
    environment: env.SALES_ENVIRONMENT,
    cloud_env_id: env.TCB_ENV,
    cutover_at: Number(env.SALES_SOURCE_CUTOVER_AT),
  });
}

/** Resolve only a server registry's env reference; never interpret paths or URLs. */
export function resolveSalesCredential(
  ref: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const name = /^env:([A-Za-z_][A-Za-z0-9_]{0,127})$/.exec(ref)?.[1];
  return name && Object.hasOwn(env, name) ? env[name] : undefined;
}
export const SourceRegistrationSchema = z
  .object({
    schema_version: z.literal('1'),
    client_id: id,
    business_line: id,
    source_installation_id: id,
    environment: z.enum(['test', 'production']),
    source: z
      .object({
        kind: z.enum(['oem', 'product']),
        id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    event: z.unknown().transform((value, ctx) => {
      try {
        return validateContract('inquiry', value);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid source event' });
        return z.NEVER;
      }
    }),
    registered_at: seconds,
    cutover_at: seconds,
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.registered_at < r.cutover_at ||
      Math.floor(Date.parse(r.event.submitted_at) / 1000) < r.cutover_at ||
      Math.floor(Date.parse(r.event.submitted_at) / 1000) > r.registered_at ||
      r.event.client_id !== r.client_id ||
      r.event.business_line !== r.business_line ||
      r.event.source_installation_id !== r.source_installation_id ||
      r.event.source_record_id !== r.source.id ||
      r.event.source_revision !== r.source.revision ||
      r.event.source !== (r.source.kind === 'oem' ? 'website_oem' : 'website_product')
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent source registration' });
  });
export type SourceRegistration = z.infer<typeof SourceRegistrationSchema>;
export function validateSourceRegistration(value: unknown): SourceRegistration {
  return SourceRegistrationSchema.parse(value);
}
export function registrationKey(record: SourceRegistration): string {
  const r = validateSourceRegistration(record);
  return hashCanonicalJson({
    client_id: r.client_id,
    business_line: r.business_line,
    source_installation_id: r.source_installation_id,
    environment: r.environment,
    source: r.source,
  });
}
export function createInitialSourceDelivery(registration: SourceRegistration) {
  const record = validateSourceRegistration(registration);
  return {
    schema_version: '1' as const,
    client_id: record.client_id,
    business_line: record.business_line,
    source_installation_id: record.source_installation_id,
    environment: record.environment,
    registration_key: registrationKey(record),
    registration_sha256: hashCanonicalJson(record),
    status: 'pending' as const,
    attempt: 0,
    lease_id: null,
    lease_until: 0,
    next_attempt_at: 0,
    receipt: null,
  };
}
export function assertSalesInstallation(value: unknown, scope: SalesCaptureScope): void {
  const parsed = z
    .object({
      client_id: id,
      business_line: id,
      source_installation_id: id,
      environment: z.enum(['test', 'production']),
      cloud_env_id: z.string(),
      state: z.literal('active'),
    })
    .strict()
    .parse(value);
  if (
    parsed.client_id !== scope.client_id ||
    parsed.business_line !== scope.business_line ||
    parsed.source_installation_id !== scope.source_installation_id ||
    parsed.environment !== scope.environment ||
    parsed.cloud_env_id !== scope.cloud_env_id
  )
    throw new Error('Sales installation mismatch');
}
export async function planSalesSubmission(
  scopeValue: SalesCaptureScope,
  kind: 'oem' | 'product',
  row: CollectionDoc,
  file: CollectionDoc | null,
  now: number,
) {
  const scope = parseSalesCaptureScope(scopeValue);
  if (
    !Number.isSafeInteger(now) ||
    now < scope.cutover_at ||
    typeof row.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    Math.floor(Date.parse(row.createdAt) / 1000) < scope.cutover_at ||
    Math.floor(Date.parse(row.createdAt) / 1000) > now
  )
    throw new Error('Source is outside capture window');
  const owner = {
    client_id: scope.client_id,
    business_line: scope.business_line,
    source_installation_id: scope.source_installation_id,
  };
  for (const [key, value] of Object.entries(owner))
    if (Object.hasOwn(row, key) && row[key] !== value)
      throw new Error('Conflicting source ownership');
  const project = { ...row, ...owner };
  const source = await readSalesInquiry(
    {
      ...scope,
      readDoc: async (collection, id) =>
        collection === 'files'
          ? file?._id === id
            ? file
            : null
          : project._id === id
            ? project
            : null,
    },
    kind,
    row._id,
  );
  const event: InquirySubmitted = canonicalInquiryEvent(owner, source.view);
  const registration = validateSourceRegistration({
    schema_version: '1',
    ...owner,
    environment: scope.environment,
    source: { kind, id: row._id, revision: source.view.source_revision },
    event,
    registered_at: now,
    cutover_at: scope.cutover_at,
  });
  return {
    project: {
      ...project,
      salesSubmissionState: 'finalized',
      salesSubmittedRevision: source.view.source_revision,
    },
    registration,
  };
}
/** Server result after the single-winner secret claim and actual byte verification.
 * This is never parsed from a public request or exposed as an agent tool. */
export interface VerifiedOemClaim {
  fileId: string;
  storageFileId: string;
  byteSize: number;
  checksumSha256: string;
  mimeType: string;
}
export interface FinalizedSalesOemInput {
  projectId: string;
  projectData: Record<string, unknown>;
  claim?: VerifiedOemClaim;
}
export async function saveFinalizedOemInCloud(
  db: NodeSdkDatabase,
  input: FinalizedSalesOemInput,
  scopeValue: SalesCaptureScope,
  now = Math.floor(Date.now() / 1000),
): Promise<CollectionDoc> {
  const scope = parseSalesCaptureScope(scopeValue);
  return db.runTransaction(async (tx) => {
    const read = async (collection: string, id: string) =>
      normalizeSalesSdkDocument(await tx.collection(collection).doc(id).get(), id);
    const install = await read('channelSalesInstallations', scope.source_installation_id);
    assertSalesInstallation(install?.record, scope);
    if (await read('oemProjects', input.projectId)) throw new Error('OEM identity already exists');
    const drawing = input.claim?.fileId ?? '';
    let file: CollectionDoc | null = null;
    if (input.claim) {
      const claim = input.claim;
      file = await read('files', claim.fileId);
      if (
        !file ||
        file.status !== 'pending' ||
        typeof file.finalizeClaim !== 'number' ||
        !Number.isSafeInteger(file.finalizeClaim) ||
        // Losing retries increment the counter too; only the server's winner reaches this method.
        file.finalizeClaim < 1 ||
        file.storageFileId !== claim.storageFileId ||
        file.purpose !== 'oem-drawing' ||
        file.storageProvider !== 'cloudbase-storage' ||
        file.client_id !== scope.client_id ||
        file.business_line !== scope.business_line ||
        file.source_installation_id !== scope.source_installation_id ||
        typeof file.uploadSecretHash !== 'string' ||
        !file.uploadSecretHash ||
        typeof file.uploadExpiresAt !== 'string' ||
        !Number.isFinite(Date.parse(file.uploadExpiresAt)) ||
        Date.parse(file.uploadExpiresAt) <= now * 1000
      )
        throw new Error('OEM upload cannot be finalized');
      file = {
        ...file,
        status: 'active',
        ownerProjectId: input.projectId,
        byteSize: claim.byteSize,
        checksumSha256: claim.checksumSha256,
        mimeType: claim.mimeType,
        uploadSecretHash: '',
      };
    }
    const at = new Date(now * 1000).toISOString();
    const plan = await planSalesSubmission(
      scope,
      'oem',
      { ...input.projectData, _id: input.projectId, drawing, createdAt: at, updatedAt: at },
      file,
      now,
    );
    const key = registrationKey(plan.registration);
    if (await read('channelSalesSourceRegistrations', key))
      throw new Error('Source registration already exists');
    if (await read('channelSalesSourceDeliveries', key))
      throw new Error('Source delivery already exists');
    const write = async (
      collection: string,
      id: string,
      value: CollectionDoc | Record<string, unknown>,
    ) => {
      const { _id: _omit, ...data } = value;
      assertSalesSdkWrite(await tx.collection(collection).doc(id).set(data), id);
    };
    if (file) await write('files', file._id, file);
    await write('oemProjects', input.projectId, plan.project);
    await write('channelSalesSourceRegistrations', key, { record: plan.registration });
    await write('channelSalesSourceDeliveries', key, {
      record: createInitialSourceDelivery(plan.registration),
    });
    return plan.project;
  });
}
