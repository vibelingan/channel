import {
  hashCanonicalJson,
  validateContract,
  type TaskReadLease,
  type SourceHandoff,
  type TaskAuthority,
  type TaskReadRequest,
} from '@vibelingan-channel/sales-contracts';
import { issueTaskPermit, TaskAccessDenied } from '@vibelingan-channel/sales-contracts/task-access';
import { readInquiry } from './sources.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { type SalesRequest, type SalesDependencies, createSalesHandler } from './handler.ts';

export async function setup() {
  const registry = JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/sales-contracts/fixtures/client-bindings.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const pdf = Buffer.from('%PDF-1.7\nsynthetic drawing\n');
  const file = {
    _id: 'drawing_a',
    client_id: 'client_a',
    business_line: 'website_sales',
    source_installation_id: 'site_a',
    name: 'design.pdf',
    purpose: 'oem-drawing',
    status: 'active',
    ownerProjectId: 'oem_a',
    storageProvider: 'cloudbase-storage',
    storageFileId: 'cloud://env_a.bucket/oem/2026/drawing',
    uploadSecretHash: '',
    storagePath: 'oem/2026/drawing',
    byteSize: pdf.byteLength,
    checksumSha256: createHash('sha256').update(pdf).digest('hex'),
    mimeType: 'application/pdf',
  };
  const oem = {
    _id: 'oem_a',
    client_id: 'client_a',
    business_line: 'website_sales',
    source_installation_id: 'site_a',
    salesSubmissionState: 'finalized',
    salesSubmittedRevision: '',
    company: 'Buyer A',
    contact: 'Alex',
    email: 'buyer@example.invalid',
    whatsapp: '123',
    category: 'headphones',
    quantity: 500,
    drawing: 'drawing_a',
    status: 'new',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    uploadSecret: 'never-project-private-fields',
  };
  const quoteId = '12345678-1234-4234-8234-123456789012';
  const quote = {
    _id: quoteId,
    client_id: 'client_a',
    business_line: 'website_sales',
    source_installation_id: 'site_a',
    schemaVersion: 'catalog-quote-request-v1',
    target: { intent: 'customization', productId: 'product_a', revision: 'r1' },
    fields: {
      intent: 'customization',
      quantity: '500',
      deliveryDate: '',
      customizationTypes: ['logo'],
      brief: 'Please print our company logo',
      contactName: 'Alex',
      email: 'buyer@example.invalid',
      company: 'Buyer A',
      country: 'US',
    },
    snapshot: {
      productName: 'Approved headphones',
      productId: 'product_a',
      revision: 'r1',
      images: [],
      productOffers: [],
    },
    status: 'new',
    version: 0,
    notification: 'disabled',
    createdAt: oem.createdAt,
    updatedAt: oem.updatedAt,
    events: new Array<Record<string, unknown>>(),
    privateSupplierCost: 'must-not-project',
  };
  const rows = new Map<string, CollectionDoc>([
    ['oemProjects/oem_a', oem],
    ['files/drawing_a', file],
    [`catalogQuoteRequests/${quoteId}`, quote],
  ]);
  const calls: string[] = [];
  let failReads = false;
  let downloaded: Buffer = Buffer.from(pdf);
  type Authorization = {
    lease: TaskReadLease;
    handoff: SourceHandoff;
    authority: TaskAuthority;
    token: string;
  };
  const authorizations = new Map<'oem' | 'product', Authorization>();
  const now = 1700000000;
  let permitHook: ((request: TaskReadRequest) => Promise<unknown>) | undefined;
  const dependencies: SalesDependencies = {
    client_id: 'client_a',
    business_line: 'website_sales',
    installation_id: 'site_a',
    environment: 'test',
    cloud_env_id: 'env_a',
    taskAccess: {
      now: () => now,
      loadInstallation: async () => ({
        client_id: 'client_a',
        business_line: 'website_sales',
        source_installation_id: 'site_a',
        environment: 'test',
        cloud_env_id: 'env_a',
        state: 'active',
      }),
      loadLease: async (hash) =>
        structuredClone(
          [...authorizations.values()].find((a) => a.lease.lease_sha256 === hash)?.lease,
        ),
      loadHandoff: async (hash) =>
        structuredClone(
          [...authorizations.values()].find((a) => a.handoff.handoff_sha256 === hash)?.handoff,
        ),
      fetchPermit: async (request) => {
        if (permitHook) return permitHook(request);
        const record = [...authorizations.values()].find(
          (a) => a.authority.task_id === request.task_id,
        );
        if (!record) throw new TaskAccessDenied();
        return issueTaskPermit(request, record.authority, now);
      },
    },
    loadRegistry: async () => structuredClone(registry),
    loadCredential: async (ref) => (ref === 'env:AGENT_a' ? 'a'.repeat(48) : 'b'.repeat(48)),
    readDoc: async (collection, id) => {
      if (failReads) throw new Error('private-provider-error');
      calls.push(`${collection}/${id}`);
      return structuredClone(rows.get(`${collection}/${id}`) ?? null);
    },
    readFile: async (id) => {
      calls.push(id);
      return {
        body: downloaded.toString('base64'),
        byteSize: downloaded.byteLength,
      };
    },
    readApprovedProduct: async (id, page, pageSize, revision) => {
      calls.push(`product/${id}/${page}/${pageSize}/${revision ?? ''}`);
      return {
        ok: true,
        data: {
          _id: id,
          name: 'Approved product',
          revision: 'r2',
          offers: [],
          variants: { items: [], page, pageSize, total: 0, hasMore: false },
        },
      };
    },
  };
  const base = JSON.parse(
    readFileSync(
      new URL('../../../../packages/sales-contracts/fixtures/task-access.json', import.meta.url),
      'utf8',
    ),
  );
  const enroll = async (kind: 'oem' | 'product' = 'oem') => {
    const source = (await readInquiry(dependencies, kind, kind === 'oem' ? 'oem_a' : quoteId)).view;
    const revision = (authorizations.get(kind)?.lease.task_revision ?? 0) + 1;
    const token = Buffer.alloc(32, kind === 'oem' ? 1 : 2).toString('base64url');
    const leaseHash = createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex');
    const sourceRef = {
      kind,
      id: source.source_record_id,
      revision: source.source_revision,
    };
    const handoffHash = hashCanonicalJson(sourceRef);
    const task = {
      task_id: `task_${kind}`,
      run_id: `run_${kind}_${revision}`,
      task_revision: revision,
      handoff_sha256: handoffHash,
    };
    const handoff = validateContract('sales-auth-handoff', {
      ...base.handoff,
      handoff_sha256: handoffHash,
      source: sourceRef,
    });
    const lease = validateContract('sales-auth-lease', {
      ...base.lease,
      ...task,
      lease_sha256: leaseHash,
      source: sourceRef,
      asset_refs: source.assets.map((a) => a.ref),
    });
    const authority = validateContract('sales-auth-authority', {
      ...base.authority,
      ...task,
    });
    authorizations.set(kind, { lease, handoff, authority, token });
    if (kind === 'oem') oem.salesSubmittedRevision = source.source_revision;
  };
  await enroll('oem');
  await enroll('product');
  calls.length = 0;
  const handler = createSalesHandler(dependencies);
  const request = (url = '/integrations/sales/inquiries/oem/oem_a'): SalesRequest => {
    const record = authorizations.get(
      url.includes(`/inquiries/product/${quoteId}`) ? 'product' : 'oem',
    );
    if (!record) throw new Error('Missing test enrollment');
    return {
      method: 'GET',
      url,
      headers: {
        'x-sales-lease': record.token,
        'x-sales-task': Buffer.from(
          JSON.stringify({
            protocol: 'sales-auth/1',
            task_id: record.lease.task_id,
            run_id: record.lease.run_id,
            task_revision: record.lease.task_revision,
            request_id: 'request_0000000001',
          }),
        ).toString('base64url'),
        authorization: `Bearer ${'a'.repeat(48)}`,
        'x-sales-connection-id': 'agent_a',
        'x-sales-context': Buffer.from(
          JSON.stringify({
            client_id: 'client_a',
            business_line: 'website_sales',
            source_installation_id: 'site_a',
            runtime_id: 'runtime_a',
            environment: 'test',
            control_epoch: 1,
          }),
        ).toString('base64url'),
      },
    };
  };
  return {
    registry,
    dependencies,
    enroll,
    authorization: (kind: 'oem' | 'product' = 'oem') => {
      const value = authorizations.get(kind);
      if (!value) throw new Error('No authorization');
      return value;
    },
    setPermit: (hook: (request: TaskReadRequest) => Promise<unknown>) => {
      permitHook = hook;
    },
    handler,
    request,
    rows,
    calls,
    file,
    oem,
    quote,
    quoteId,
    pdf,
    setReadFailure: () => {
      failReads = true;
    },
    setDownload: (bytes: Buffer) => {
      downloaded = bytes;
    },
  };
}
