import type { CatalogSourceObservation } from '@vibelingan-channel/catalog-import/observations';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import { type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import type {
  ApprovalPersistenceCommand,
  ApprovalStageResult,
} from '@vibelingan-channel/db/catalog-detail-staging';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { completeSourceMirrorFixtures } from '../../../alibaba-catalog-sync/src/testing/source-observation-fixture.ts';

const unused = async (): Promise<never> => {
  throw new Error('Read plan attempted an unexpected mutation or query');
};
export class ReadPlanAdapter implements DbAdapter {
  commands: ApprovalPersistenceCommand[] = [];
  constructor(readonly rows: Record<string, CollectionDoc[]>) {
    completeSourceMirrorFixtures(rows);
  }
  async get(collection: string, id: string) {
    return structuredClone(this.rows[collection]?.find((row) => row._id === id) ?? null);
  }
  async persistCatalogDetailApproval(
    _actor: string,
    input: ApprovalPersistenceCommand,
  ): Promise<ApprovalStageResult> {
    this.commands.push(input);
    return {
      ok: true,
      jobId: 'recording',
      revision: 'recording',
      nextPage: 1,
      pages: 1,
      complete: true,
    };
  }
  list: DbAdapter['list'] = async (query) => {
    const clause = query.filter?.clauses[0];
    if (
      query.collection !== 'catalogSourceLinks' ||
      query.page !== 1 ||
      query.pageSize !== 100 ||
      query.filter?.combinator !== 'and' ||
      query.filter.clauses.length !== 1 ||
      !clause ||
      clause.field !== '_id' ||
      clause.op !== 'in' ||
      !Array.isArray(clause.value) ||
      !clause.value.every((value) => typeof value === 'string')
    )
      return unused();
    const ids = new Set(clause.value);
    const items = structuredClone(
      (this.rows.catalogSourceLinks ?? []).filter((row) => ids.has(row._id)),
    );
    return { items, total: items.length, page: 1, pageSize: 100 };
  };
  findByField = unused;
  create = unused;
  update = unused;
  remove = unused;
  incrementField = unused;
}

export function fixture(count: number) {
  const product: CollectionDoc = {
    _id: 'read-product',
    name: 'Website title',
    description: 'Website description',
    alibabaPrimarySourceKey: 'read-source',
    catalogContentGeneration: 4,
    published: false,
    productFamily: 'misc',
    imageIds: [],
  };
  const observation: CatalogSourceObservation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: 'read-source',
      externalProductId: 'external',
      observedAt: '2026-10-14T00:00:00.000Z',
      captureMode: 'selected',
      completeness: 'full-product',
    },
    identity: {
      title: 'Supplier title',
      matchHints: {},
      attributes: [{ sourceName: 'Material', value: 'ABS' }],
    },
    content: {
      description: {
        text: 'Supplier description',
        placeholder: false,
        sanitized: true,
        provenance: 'provider-description',
      },
      media: [],
    },
    lifecycle: { sourceListingStatus: 'published' },
    variants: Array.from({ length: count }, (_, index) => ({
      sourceVariantKey: `sku-${index}`,
      sku: `SKU-${index}`,
      options: [{ sourceName: 'Color', value: `Color ${index}` }],
      inventory: [],
      media: [],
    })),
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'a'.repeat(64) }],
    warnings: [],
  };
  const adapter = new ReadPlanAdapter({
    users: [{ _id: 'admin', role: 'admin', status: 'active' }],
    products: [product],
    catalogSourceObservations: [
      { _id: sourceObservationDocumentId('alibaba', 'read-source'), active: true, observation },
    ],
  });
  setAdapter(adapter);
  return { product, observation, adapter };
}
