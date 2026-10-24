import {
  CATALOG_MEDIA_SEAL_POLICY,
  CATALOG_PIXEL_POLICY,
  CATALOG_PREPARATION_POLICY,
} from '@vibelingan-channel/shared/catalog-preparation';
const policy = CATALOG_PREPARATION_POLICY;
const hex = 'a'.repeat(64);
export function prepared(id: string, state: 'ready' | 'blocked' | 'preparing' = 'ready') {
  return {
    _id: id,
    name: `Clock ${id}`,
    published: false,
    productFamily: 'misc',
    catalogContentGeneration: 2,
    catalogPreparationState: state,
    catalogPreparationPolicy: policy,
    catalogPreparationReport: {
      schemaVersion: 'catalog-preparation-report-v2',
      productId: id,
      inputDigest: hex,
      contentGeneration: 2,
      policyVersion: policy,
      checkedAt: '2026-10-17T00:00:00.000Z',
      state,
      previewReady: state !== 'blocked',
      mediaReady: state === 'ready',
      issues:
        state === 'blocked'
          ? [
              {
                code: 'REQUIRED',
                stage: 'effective-content',
                path: 'name',
                severity: 'error',
                remedy: 'edit',
              },
            ]
          : [],
      ...(state === 'ready'
        ? {
            seal: {
              kind: 'catalog-preparation-ready-seal-v1',
              jobId: hex,
              receiptId: hex,
              planDigest: hex,
              imageIdsDigest: hex,
              imageCount: 0,
              mediaPolicyVersion: CATALOG_MEDIA_SEAL_POLICY,
              pixelPolicyVersion: CATALOG_PIXEL_POLICY,
            },
          }
        : {}),
    },
  };
}
export function rows(): Record<string, unknown>[] {
  const valid = prepared('ready');
  const request = (productId: string, contentGeneration: number) => ({
    schemaVersion: 'catalog-preparation-request-v1',
    productId,
    contentGeneration,
    jobId: hex,
    inputDigest: hex,
    policyVersion: policy,
    requestedAt: '2026-10-17T00:00:00.000Z',
  });
  return [
    valid,
    prepared('blocked', 'blocked'),
    prepared('preparing', 'preparing'),
    {
      _id: 'checking',
      name: 'Clock checking',
      published: false,
      catalogContentGeneration: 2,
      catalogPreparationState: 'checking',
      catalogPreparationPolicy: policy,
      catalogPreparationRequest: {
        schemaVersion: 'catalog-preparation-request-v1',
        productId: 'checking',
        jobId: hex,
        inputDigest: hex,
        contentGeneration: 2,
        policyVersion: policy,
        requestedAt: '2026-10-17T00:00:00.000Z',
      },
    },
    { ...prepared('live-blocked', 'blocked'), published: true },
    { ...prepared('unclassified'), productFamily: undefined },
    { _id: 'legacy', name: 'Clock legacy' },
    { ...prepared('stale'), catalogPreparationState: 'stale' },
    { ...prepared('old-policy'), catalogPreparationPolicy: 'old' },
    { ...prepared('array-policy'), catalogPreparationPolicy: [policy] },
    {
      ...prepared('array-flags'),
      catalogPreparationReport: {
        ...valid.catalogPreparationReport,
        productId: 'array-flags',
        mediaReady: [true],
      },
    },
    {
      ...prepared('wrong-seal-policy'),
      catalogPreparationReport: {
        ...valid.catalogPreparationReport,
        productId: 'wrong-seal-policy',
        seal: { ...valid.catalogPreparationReport.seal, pixelPolicyVersion: 'old' },
      },
    },
    {
      ...prepared('wrong-request-product'),
      catalogPreparationState: 'checking',
      catalogPreparationRequest: request('other', 2),
    },
    {
      ...prepared('wrong-request-generation'),
      catalogPreparationState: 'checking',
      catalogPreparationRequest: request('wrong-request-generation', 3),
    },
    {
      ...prepared('legacy-ready'),
      catalogContentGeneration: undefined,
      catalogPreparationReport: {
        ...valid.catalogPreparationReport,
        productId: 'legacy-ready',
        contentGeneration: 0,
      },
    },
    { ...prepared('wrong-generation'), catalogContentGeneration: 3 },
    { ...prepared('wrong-product'), catalogPreparationReport: valid.catalogPreparationReport },
    { ...prepared('array-state'), catalogPreparationState: ['ready'] },
    { ...prepared('array-published', 'blocked'), published: [true] },
    { ...prepared('no-report'), catalogPreparationReport: null },
    { _id: 'waiting', alibabaPhotosPending: true, name: 'Clock waiting' },
    {
      ...prepared('wrong-flags'),
      catalogPreparationReport: {
        ...valid.catalogPreparationReport,
        productId: 'wrong-flags',
        mediaReady: false,
      },
    },
    {
      ...prepared('old-format'),
      catalogPreparationReport: {
        ...valid.catalogPreparationReport,
        productId: 'old-format',
        schemaVersion: 'catalog-preparation-report-v1',
      },
    },
  ];
}
export const expected = {
  all: rows()
    .map((row) => String(row._id))
    .sort(),
  normal: ['legacy-ready', 'live-blocked', 'ready', 'unclassified'],
  issues: ['array-published', 'blocked'],
  preparing: ['checking', 'preparing'],
  unchecked: [
    'array-flags',
    'array-policy',
    'array-state',
    'legacy',
    'no-report',
    'old-format',
    'old-policy',
    'stale',
    'waiting',
    'wrong-flags',
    'wrong-generation',
    'wrong-product',
    'wrong-request-generation',
    'wrong-request-product',
    'wrong-seal-policy',
  ],
};
