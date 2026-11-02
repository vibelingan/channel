import type { CollectionDoc } from '@vibelingan-channel/shared';
import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';
import { createDeliveryStore, type DeliveryDatabase } from './delivery-store.ts';
import { HttpInquirySender, type InquirySender } from './inquiry-sender.ts';
import { WebsiteDelivery } from './website-delivery.ts';
import type { createWebsiteFixture } from './website-test-fixtures.ts';

type WebsiteFixture = ReturnType<typeof createWebsiteFixture>;
/** Mechanical query adapter; producer and delivery share the same transaction queue. */
export function fixtureDeliveryDatabase(
  rows: Map<string, CollectionDoc>,
  database: NodeSdkDatabase,
): DeliveryDatabase {
  return {
    runTransaction: (operation) => database.runTransaction(operation),
    command: { gt: (value) => ({ $gt: value }), in: (values) => ({ $in: values }) },
    collection: (name) => ({
      where: (filters) => {
        let order = '_id';
        let direction: 'asc' | 'desc' = 'asc';
        let size = 100;
        const query = {
          orderBy: (field: string, sort: 'asc' | 'desc') => {
            order = field;
            direction = sort;
            return query;
          },
          limit: (limit: number) => {
            size = limit;
            return query;
          },
          get: async () => {
            const data = [...rows]
              .filter(([key]) => key.startsWith(name + '/'))
              .map(([, row]) => row)
              .filter((row) =>
                Object.entries(filters).every(([field, expected]) => {
                  const value =
                    field === '_id'
                      ? row._id
                      : row.record && typeof row.record === 'object'
                        ? Reflect.get(row.record, field.slice('record.'.length))
                        : undefined;
                  if (expected && typeof expected === 'object' && '$in' in expected)
                    return Array.isArray(expected.$in) && expected.$in.includes(value);
                  return expected && typeof expected === 'object' && '$gt' in expected
                    ? typeof value === 'string' &&
                        typeof expected.$gt === 'string' &&
                        value > expected.$gt
                    : value === expected;
                }),
              )
              .sort(
                (left, right) =>
                  String(left[order]).localeCompare(String(right[order]), 'en') *
                  (direction === 'asc' ? 1 : -1),
              )
              .slice(0, size);
            return { data: structuredClone(data) };
          },
        };
        return query;
      },
    }),
  };
}
export function createWebsiteDeliveryFixture(
  fixture: WebsiteFixture,
  options: {
    endpoint?: string;
    sender?: InquirySender;
    sourceToken?: string;
    now?: () => number;
  } = {},
) {
  const sourceToken = options.sourceToken ?? 's'.repeat(48);
  const sender =
    options.sender ??
    new HttpInquirySender(
      options.endpoint ?? 'http://127.0.0.1:1/sales/events',
      sourceToken,
      'test',
    );
  const store = createDeliveryStore(fixtureDeliveryDatabase(fixture.rows, fixture.database));
  const delivery = new WebsiteDelivery({
    enabled: true,
    scope: { ...fixture.scope, runtime_id: 'runtime_a', control_epoch: 1 },
    connection_id: 'agent_a',
    source_token: sourceToken,
    sender,
    store,
    now: options.now ?? (() => Math.floor(Date.now() / 1000)),
    loadCredential: async (ref) =>
      ref === 'env:AGENT_a' ? 'r'.repeat(48) : ref === 'env:SALES_a' ? 'c'.repeat(48) : undefined,
  });
  return { delivery, store, sender };
}
