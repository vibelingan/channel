import { createHash } from 'node:crypto';
import { canonicalInquiryEvent } from './canonical-source-event.ts';
import { createSalesHandler, type SalesRequest } from './handler.ts';
import { readInquiry } from './sources.ts';
import type { SourceGrantStore, SourceGrantTransaction } from './source-grants.ts';
import { setup } from './test-fixtures.ts';

/** Serializable synthetic storage; never contacts CloudBase. */
export class MemoryGrantStore implements SourceGrantStore {
  rows = new Map<string, unknown>();
  entered = 0;
  failWrites = false;
  failAtWrite: number | undefined;
  private queued = Promise.resolve();

  async transaction<T>(operation: (tx: SourceGrantTransaction) => Promise<T>): Promise<T> {
    const previous = this.queued;
    let unlock = () => {};
    this.queued = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    this.entered += 1;
    const staged = new Map([...this.rows].map(([key, value]) => [key, structuredClone(value)]));
    let writes = 0;
    try {
      const result = await operation({
        read: async (collection, id) => structuredClone(staged.get(`${collection}/${id}`) ?? null),
        write: async (collection, id, data) => {
          writes += 1;
          if (this.failWrites || this.failAtWrite === writes)
            throw new Error('synthetic storage fault');
          staged.set(`${collection}/${id}`, {
            ...structuredClone(data),
            _id: id,
          });
        },
      });
      this.rows = staged;
      return result;
    } finally {
      unlock();
    }
  }
}

export async function grantFixture(kind: 'oem' | 'product' = 'oem') {
  const original = await setup();
  const store = new MemoryGrantStore();
  store.rows = new Map([...original.rows].map(([key, value]) => [key, structuredClone(value)]));
  store.rows.set('channelSalesBindings/site_a', {
    _id: 'site_a',
    registry: original.registry,
  });
  store.rows.set('channelSalesInstallations/site_a', {
    _id: 'site_a',
    record: {
      client_id: 'client_a',
      business_line: 'website_sales',
      source_installation_id: 'site_a',
      environment: 'test',
      cloud_env_id: 'env_a',
      state: 'active',
    },
  });
  let now = 1700000000;
  const dependencies = {
    ...original.dependencies,
    sourceGrants: {
      enabled: true,
      token: 'g'.repeat(48),
      forbiddenTokens: ['c'.repeat(48)],
      store,
      now: () => now,
    },
  };
  const id = kind === 'oem' ? 'oem_a' : original.quoteId;
  const view = (await readInquiry(original.dependencies, kind, id)).view;
  const event = canonicalInquiryEvent(
    {
      client_id: 'client_a',
      business_line: 'website_sales',
      source_installation_id: 'site_a',
    },
    view,
  );
  const body = {
    protocol: 'sales-auth/1',
    request_id: '1'.repeat(32),
    client_id: 'client_a',
    business_line: 'website_sales',
    source_installation_id: 'site_a',
    environment: 'test',
    runtime_id: 'runtime_a',
    control_epoch: 1,
    task_id: '1',
    run_id: '2'.repeat(32),
    task_revision: 1,
    connection_id: 'agent_a',
    lease_sha256: createHash('sha256').update(Buffer.alloc(32, 7)).digest('hex'),
    event,
  };
  const request = (value: unknown = body, token = 'g'.repeat(48)): SalesRequest => ({
    method: 'POST',
    url: '/integrations/sales/source-grants',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: Buffer.from(JSON.stringify(value)),
  });
  return {
    ...original,
    dependencies,
    store,
    body,
    view,
    request,
    handler: createSalesHandler(dependencies),
    setNow: (value: number) => {
      now = value;
    },
  };
}
