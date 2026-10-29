import { randomUUID } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CatalogPublicHeadSchema,
  CatalogSeoTaskSchema,
  catalogPublicRecordId,
} from './catalog-public-changes.ts';
import type { CatalogSeoStore } from './catalog-seo-consumer.ts';
import {
  CatalogSeoControlSchema,
  CatalogSeoPageSchema,
  catalogSeoControlId,
  idleCatalogSeoControl,
  readCatalogSeoControl,
} from './catalog-seo-control.ts';

export class CatalogSeoDeliveryChangedError extends Error {
  readonly code = 'STOP_CATALOG_CHANGE';
  constructor() {
    super('Public products changed. Rebuild from current data before further delivery.');
  }
}
export interface CatalogSeoDeliveryTicket {
  owner: string;
  fence: number;
  products: readonly string[];
}
export function createCatalogSeoDelivery(
  store: CatalogSeoStore,
  siteOrigin: string,
  expectedWrites: number,
  runId: string,
  clock = () => new Date().toISOString(),
) {
  const controlId = catalogSeoControlId(siteOrigin);
  const heads = new Map<string, ReturnType<typeof CatalogPublicHeadSchema.parse>>();
  const ticketOwners = new Set<string>();
  const changed = () => {
    throw new CatalogSeoDeliveryChangedError();
  };
  return {
    async check() {
      const c = readCatalogSeoControl(
        await store.get('catalogSeoControl', controlId),
        siteOrigin,
        clock(),
      );
      if (c.writes !== expectedWrites || c.state !== 'idle') changed();
    },
    async begin(products: readonly string[], discovery = false): Promise<CatalogSeoDeliveryTicket> {
      if (
        products.length > 12 ||
        new Set(products).size !== products.length ||
        (!products.length && !discovery)
      )
        throw Error('Invalid SEO delivery batch');
      const now = clock();
      const owner = `${runId}:${randomUUID()}`;
      const prepared = await store.transaction(async (tx) => {
        const c = readCatalogSeoControl(
          await tx.get('catalogSeoControl', controlId),
          siteOrigin,
          now,
        );
        if (c.writes !== expectedWrites || c.state !== 'idle') changed();
        const records = [];
        for (const productId of products) {
          const id = catalogPublicRecordId(siteOrigin, productId);
          const head = await tx.get('catalogPublicHeads', id);
          const task = await tx.get('catalogSeoTasks', id);
          if (!head && !task) continue; // unchanged, previously accepted legacy page
          const h = CatalogPublicHeadSchema.parse(head);
          const t = CatalogSeoTaskSchema.parse(task);
          if (
            h._id !== id ||
            h.siteOrigin !== siteOrigin ||
            h.productId !== productId ||
            t._id !== id ||
            t.siteOrigin !== siteOrigin ||
            t.productId !== productId ||
            h.sequence !== t.requestedSequence
          )
            throw Error('SEO delivery record mismatch');
          if (t.lease && t.lease.runId !== runId)
            throw Error('Earlier SEO delivery needs readback');
          records.push({ head: h, task: t });
        }
        const next = CatalogSeoControlSchema.parse({
          ...c,
          state: 'writing',
          owner,
          until: new Date(Date.parse(now) + 30_000).toISOString(),
          fence: c.fence + 1,
          products: [...products],
          families: ['headphones', 'ai-gadgets', 'toys', 'misc'],
          discovery,
          updatedAt: now,
        });
        await tx.set('catalogSeoControl', next);
        for (const { head, task } of records)
          if (task.acceptedSequence < head.sequence)
            await tx.set(
              'catalogSeoTasks',
              CatalogSeoTaskSchema.parse({
                ...task,
                state: 'writing',
                attempts: task.attempts + (task.lease ? 0 : 1),
                lease: { runId, sequence: head.sequence, until: next.until },
              }),
            );
        return { ticket: { owner, fence: next.fence, products: [...products] }, records };
      });
      for (const row of prepared.records) heads.set(row.head.productId, row.head);
      ticketOwners.add(owner);
      return Object.freeze(prepared.ticket);
    },
    async end(ticket: CatalogSeoDeliveryTicket, outcome: 'verified' | 'unknown') {
      if (!ticketOwners.has(ticket.owner)) throw Error('Unknown SEO delivery ticket');
      await store.transaction(async (tx) => {
        const now = clock();
        const c = readCatalogSeoControl(
          await tx.get('catalogSeoControl', controlId),
          siteOrigin,
          now,
        );
        if (c.owner !== ticket.owner || c.fence !== ticket.fence || c.state !== 'writing')
          throw Error('SEO delivery ownership changed');
        // Expiry never releases an operation whose storage outcome is unknown.
        await tx.set(
          'catalogSeoControl',
          outcome === 'unknown'
            ? { ...c, state: 'needs-readback', updatedAt: now }
            : { ...idleCatalogSeoControl(siteOrigin, now), writes: c.writes, fence: c.fence },
        );
      });
      ticketOwners.delete(ticket.owner);
    },
    async retryKnownFailure() {
      const current = readCatalogSeoControl(
        await store.get('catalogSeoControl', controlId),
        siteOrigin,
        clock(),
      );
      if (current.state !== 'idle' || ticketOwners.size)
        throw Error('Unknown delivery cannot release its tasks');
      for (let offset = 0; offset < heads.size; offset += 12)
        await store.transaction(async (tx) => {
          const now = clock();
          const c = readCatalogSeoControl(
            await tx.get('catalogSeoControl', controlId),
            siteOrigin,
            now,
          );
          if (c.state !== 'idle' || ticketOwners.size)
            throw Error('Unknown delivery cannot release its tasks');
          const tasks = [];
          for (const productId of [...heads.keys()].slice(offset, offset + 12)) {
            const id = catalogPublicRecordId(siteOrigin, productId);
            const task = CatalogSeoTaskSchema.parse(await tx.get('catalogSeoTasks', id));
            if (task._id !== id || task.productId !== productId || task.siteOrigin !== siteOrigin)
              throw Error('Wrong delivery task');
            if (task.lease?.runId === runId)
              tasks.push(CatalogSeoTaskSchema.parse({ ...task, state: 'pending', lease: null }));
          }
          await tx.set('catalogSeoControl', { ...c, updatedAt: now });
          for (const task of tasks) await tx.set('catalogSeoTasks', task);
        });
    },
    async accept(pages: readonly { productId: string; htmlSha256: string | null }[]) {
      if (new Set(pages.map((p) => p.productId)).size !== pages.length)
        throw Error('Duplicate SEO acceptance page');
      // Each transaction stays below the documented 100-operation SDK limit.
      for (let offset = 0; offset < pages.length; offset += 12)
        await store.transaction(async (tx) => {
          const now = clock();
          const c = readCatalogSeoControl(
            await tx.get('catalogSeoControl', controlId),
            siteOrigin,
            now,
          );
          if (c.writes !== expectedWrites || c.state !== 'idle') changed();
          const writes: { collection: string; row: CollectionDoc }[] = [];
          for (const page of pages.slice(offset, offset + 12)) {
            const id = catalogPublicRecordId(siteOrigin, page.productId);
            const h = CatalogPublicHeadSchema.parse(await tx.get('catalogPublicHeads', id));
            const t = CatalogSeoTaskSchema.parse(await tx.get('catalogSeoTasks', id));
            const delivered = heads.get(page.productId);
            if (
              !delivered ||
              delivered.sequence !== h.sequence ||
              delivered.semanticHash !== h.semanticHash ||
              t.requestedSequence !== h.sequence ||
              h._id !== id ||
              h.siteOrigin !== siteOrigin ||
              h.productId !== page.productId ||
              t._id !== id ||
              t.siteOrigin !== siteOrigin ||
              t.productId !== page.productId ||
              (t.lease && (t.lease.runId !== runId || t.lease.sequence !== h.sequence))
            )
              changed();
            if (h.visible !== (page.htmlSha256 !== null)) changed();
            writes.push({
              collection: 'catalogSeoTasks',
              row: CatalogSeoTaskSchema.parse({
                ...t,
                state: 'accepted',
                acceptedSequence: h.sequence,
                lease: null,
              }),
            });
            writes.push({
              collection: 'catalogSeoPages',
              row: CatalogSeoPageSchema.parse(
                page.htmlSha256 === null
                  ? {
                      _id: id,
                      schemaVersion: 1,
                      siteOrigin,
                      productId: page.productId,
                      ready: false,
                      changedAt: now,
                    }
                  : {
                      _id: id,
                      schemaVersion: 1,
                      siteOrigin,
                      productId: page.productId,
                      ready: true,
                      sequence: h.sequence,
                      htmlSha256: page.htmlSha256,
                      acceptedAt: now,
                    },
              ),
            });
          }
          // A real write fence, not a read-only optimistic check.
          await tx.set('catalogSeoControl', { ...c, updatedAt: now });
          for (const write of writes) await tx.set(write.collection, write.row);
        });
    },
    get trackedProducts() {
      return [...heads.keys()];
    },
  };
}
