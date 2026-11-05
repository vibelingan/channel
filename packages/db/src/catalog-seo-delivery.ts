import { randomUUID } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  type CatalogPublicHead,
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
export function createCatalogSeoDeliveryStateless(
  store: CatalogSeoStore,
  siteOrigin: string,
  expectedWrites: number,
  runId: string,
  clock = () => new Date().toISOString(),
) {
  const controlId = catalogSeoControlId(siteOrigin);
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
    async begin(products: readonly string[], discovery = false) {
      if (
        products.length > 12 ||
        new Set(products).size !== products.length ||
        (!products.length && !discovery)
      )
        throw Error('Invalid SEO delivery batch');
      const now = clock();
      const owner = `${runId}:${randomUUID()}`;
      return store.transaction(async (tx) => {
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
        return {
          ticket: { owner, fence: next.fence, products: [...products] },
          expectedHeads: records.map((record) => record.head),
        };
      });
    },
    async end(ticket: CatalogSeoDeliveryTicket, outcome: 'verified' | 'unknown') {
      if (
        typeof ticket.owner !== 'string' ||
        !ticket.owner.startsWith(`${runId}:`) ||
        ticket.owner.length <= runId.length + 1 ||
        !Number.isSafeInteger(ticket.fence) ||
        ticket.fence < 1 ||
        !Array.isArray(ticket.products) ||
        ticket.products.length > 12 ||
        new Set(ticket.products).size !== ticket.products.length ||
        !['verified', 'unknown'].includes(outcome)
      )
        throw Error('Invalid SEO delivery ticket');
      await store.transaction(async (tx) => {
        const now = clock();
        const c = readCatalogSeoControl(
          await tx.get('catalogSeoControl', controlId),
          siteOrigin,
          now,
        );
        if (
          c.owner !== ticket.owner ||
          c.fence !== ticket.fence ||
          c.state !== 'writing' ||
          c.products.length !== ticket.products.length ||
          c.products.some((productId, index) => ticket.products[index] !== productId)
        )
          throw Error('SEO delivery ownership changed');
        // Expiry never releases an operation whose storage outcome is unknown.
        await tx.set(
          'catalogSeoControl',
          outcome === 'unknown'
            ? { ...c, state: 'needs-readback', updatedAt: now }
            : { ...idleCatalogSeoControl(siteOrigin, now), writes: c.writes, fence: c.fence },
        );
      });
    },
    async retryKnownFailure(productIds: readonly string[]) {
      if (productIds.length > 12 || new Set(productIds).size !== productIds.length)
        throw Error('Invalid SEO retry batch');
      await store.transaction(async (tx) => {
        const now = clock();
        const c = readCatalogSeoControl(
          await tx.get('catalogSeoControl', controlId),
          siteOrigin,
          now,
        );
        if (c.state !== 'idle') throw Error('Unknown delivery cannot release its tasks');
        const tasks = [];
        for (const productId of productIds) {
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
    async accept(
      pages: readonly { productId: string; htmlSha256: string | null }[],
      expectedHeads: readonly CatalogPublicHead[],
    ) {
      if (pages.length > 12 || new Set(pages.map((p) => p.productId)).size !== pages.length)
        throw Error('Duplicate SEO acceptance page');
      if (expectedHeads.length > 12) throw Error('SEO acceptance head batch exceeds bound');
      const heads = expectedHeadMap(expectedHeads, siteOrigin);
      await store.transaction(async (tx) => {
        const now = clock();
        const c = readCatalogSeoControl(
          await tx.get('catalogSeoControl', controlId),
          siteOrigin,
          now,
        );
        if (c.writes !== expectedWrites || c.state !== 'idle') changed();
        const writes: { collection: string; row: CollectionDoc }[] = [];
        for (const page of pages) {
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
          if (t.state === 'accepted' && t.acceptedSequence === h.sequence) {
            const existing = await tx.get('catalogSeoPages', id);
            if (existing) {
              const p = CatalogSeoPageSchema.parse(existing);
              if (p._id !== id || p.siteOrigin !== siteOrigin || p.productId !== page.productId)
                changed();
              if (
                page.htmlSha256 === null
                  ? !p.ready
                  : p.ready && p.sequence === h.sequence && p.htmlSha256 === page.htmlSha256
              )
                continue;
            }
          }
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
  };
}

/** Preserve the in-process API while regional callers pass heads and tickets explicitly. */
export function createCatalogSeoDelivery(
  store: CatalogSeoStore,
  siteOrigin: string,
  expectedWrites: number,
  runId: string,
  clock = () => new Date().toISOString(),
) {
  const core = createCatalogSeoDeliveryStateless(store, siteOrigin, expectedWrites, runId, clock);
  const heads = new Map<string, CatalogPublicHead>();
  const ticketOwners = new Set<string>();
  const primeExpectedHeads = (rows: readonly unknown[]) => {
    for (const [productId, head] of expectedHeadMap(rows, siteOrigin)) heads.set(productId, head);
  };
  return {
    check: core.check,
    primeExpectedHeads,
    async begin(products: readonly string[], discovery = false): Promise<CatalogSeoDeliveryTicket> {
      const prepared = await core.begin(products, discovery);
      primeExpectedHeads(prepared.expectedHeads);
      ticketOwners.add(prepared.ticket.owner);
      return Object.freeze(prepared.ticket);
    },
    async end(ticket: CatalogSeoDeliveryTicket, outcome: 'verified' | 'unknown') {
      if (!ticketOwners.has(ticket.owner)) throw Error('Unknown SEO delivery ticket');
      await core.end(ticket, outcome);
      ticketOwners.delete(ticket.owner);
    },
    async retryKnownFailure() {
      const current = readCatalogSeoControl(
        await store.get('catalogSeoControl', catalogSeoControlId(siteOrigin)),
        siteOrigin,
        clock(),
      );
      if (current.state !== 'idle' || ticketOwners.size)
        throw Error('Unknown delivery cannot release its tasks');
      const products = [...heads.keys()];
      for (let offset = 0; offset < products.length; offset += 12)
        await core.retryKnownFailure(products.slice(offset, offset + 12));
    },
    async accept(pages: readonly { productId: string; htmlSha256: string | null }[]) {
      if (new Set(pages.map((page) => page.productId)).size !== pages.length)
        throw Error('Duplicate SEO acceptance page');
      for (let offset = 0; offset < pages.length; offset += 12) {
        const batch = pages.slice(offset, offset + 12);
        const captured = batch.map((page) => {
          const head = heads.get(page.productId);
          if (!head) throw new CatalogSeoDeliveryChangedError();
          return head;
        });
        await core.accept(batch, captured);
      }
    },
    get trackedProducts() {
      return [...heads.keys()];
    },
  };
}

function expectedHeadMap(rows: readonly unknown[], siteOrigin: string) {
  const heads = new Map<string, CatalogPublicHead>();
  for (const row of rows) {
    const head = CatalogPublicHeadSchema.parse(row);
    if (
      head.siteOrigin !== siteOrigin ||
      head._id !== catalogPublicRecordId(siteOrigin, head.productId) ||
      heads.has(head.productId)
    )
      throw Error('Invalid expected SEO head');
    heads.set(head.productId, head);
  }
  return heads;
}
