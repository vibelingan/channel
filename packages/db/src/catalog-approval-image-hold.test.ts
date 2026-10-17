import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  approvalImageHoldAnswer,
  approvalImageHoldWhere,
  firstApprovalImageHold,
} from './catalog-approval-image-hold.ts';
import { findUnfinishedApprovalImageInCloudBase } from './cloudbase-adapter.ts';
const after = '2026-10-18T00:00:00.000Z';
const row = () => ({
  _id: 'job',
  productId: 'p',
  state: 'staging',
  createdAt: '2026-10-18T00:00:01.000Z',
  publication: {
    state: 'approved',
    header: {
      _id: 'p',
      images: ['/api/images/gallery'],
      descriptionImages: ['/api/images/description'],
    },
    variantImageIds: ['variant'],
  },
});
const command = {
  and: (conditions: Record<string, unknown>[]) => ({ $and: conditions }),
  eq: (value: unknown) => ({ $eq: value }),
  gt: (value: unknown) => ({ $gt: value }),
  expr: (expression: Record<string, unknown>) => ({ $expr: expression }),
};
for (const id of ['gallery', 'description', 'variant'])
  test(`targeted hold retains ${id} and ignores body/patch text`, () => {
    assert.equal(firstApprovalImageHold([row()], id, after), 'p');
    assert.equal(
      firstApprovalImageHold(
        [
          {
            ...row(),
            publication: {
              state: 'approved',
              header: { _id: 'p', images: [], descriptionImages: [], descriptionText: id },
              facts: [{ name: id, value: id }],
            },
            operation: { values: { imageIds: [id] } },
          },
        ],
        id,
        after,
      ),
      null,
    );
  });
for (const change of [
  'expired',
  'equal-cutoff',
  'complete',
  'wrong-header',
  'not-approved',
  'missing-product',
  'string-images',
  'gallery-tenth',
  'description-nineteenth',
] as const)
  test(`targeted hold ignores non-reference ${change}`, () => {
    const value: CollectionDoc = { ...row() };
    const pub = row().publication;
    value.publication = pub;
    if (change === 'expired') value.createdAt = '2026-10-17T23:00:00.000Z';
    if (change === 'equal-cutoff') value.createdAt = after;
    if (change === 'complete') value.state = 'complete';
    if (change === 'wrong-header') pub.header._id = 'other';
    if (change === 'not-approved') pub.state = 'draft';
    if (change === 'missing-product') Reflect.deleteProperty(value, 'productId');
    if (change === 'string-images') Reflect.set(pub.header, 'images', '/api/images/gallery');
    if (change === 'gallery-tenth')
      pub.header.images = [
        ...Array.from({ length: 9 }, (_, i) => `/api/images/x${i}`),
        '/api/images/gallery',
      ];
    if (change === 'description-nineteenth') {
      pub.header.images = [];
      pub.header.descriptionImages = [
        ...Array.from({ length: 18 }, (_, i) => `/api/images/x${i}`),
        '/api/images/gallery',
      ];
    }
    assert.equal(firstApprovalImageHold([value], 'gallery', after), null);
  });
test('all10000SKU images remain protected and are not sliced like the gallery', () => {
  const value = row();
  value.publication.variantImageIds = Array.from({ length: 10000 }, (_, i) => `sku${i}`);
  assert.equal(firstApprovalImageHold([value], 'sku9999', after), 'p');
});
for (const value of [
  undefined,
  null,
  {},
  [null],
  [{ _id: 'j' }],
  [{ _id: '', productId: 'p' }],
  [{ _id: 'j', productId: 3 }],
  [{ _id: 'j', productId: '' }],
  [
    { _id: 'a', productId: 'p' },
    { _id: 'b', productId: 'p' },
  ],
])
  test(`malformed targeted answer fails closed: ${JSON.stringify(value)}`, () => {
    assert.throws(() => approvalImageHoldAnswer(value), /not confirmed/);
  });
test('targeted answer returns only the product scalar or explicit absence', () => {
  assert.equal(approvalImageHoldAnswer([]), null);
  assert.equal(approvalImageHoldAnswer([{ _id: 'j', productId: 'p', future: 'private' }]), 'p');
});
for (const id of ['legacy.name', 'bad/id', '$field', ''])
  test(`image ID outside published reference grammar needs no approval hold: ${id}`, () => {
    assert.equal(firstApprovalImageHold([row()], id, after), null);
  });
test('targeted native query sends only the reference predicate and two fields before a single read', async () => {
  const events: string[] = [];
  let where: Record<string, unknown> | undefined;
  let projection: Readonly<Record<string, boolean>> | undefined;
  const q = {
    where: (condition: Record<string, unknown>) => {
      where = condition;
      events.push('where');
      return q;
    },
    orderBy: (field: string, dir: string) => {
      assert.equal(field, '_id');
      assert.equal(dir, 'asc');
      events.push('sort');
      return q;
    },
    limit: (n: number) => {
      assert.equal(n, 1);
      events.push('limit');
      return q;
    },
    field: (fields: Readonly<Record<string, boolean>>) => {
      projection = fields;
      events.push('field');
      return q;
    },
    get: async () => {
      events.push('get');
      return { data: [{ _id: 'j', productId: 'p' }] };
    },
    count: async (): Promise<never> => {
      throw new Error('No count');
    },
    skip: (_n: number): never => {
      throw new Error('No offset paging');
    },
    doc: (_id: string): never => {
      throw new Error('No full document read');
    },
    add: async (): Promise<never> => {
      throw new Error('No write');
    },
  };
  const db = {
    command: {
      ...command,
      or: (conditions: Record<string, unknown>[]) => ({ $or: conditions }),
      neq: (v: unknown) => ({ $ne: v }),
      gte: (v: unknown) => ({ $gte: v }),
      lt: (v: unknown) => ({ $lt: v }),
      lte: (v: unknown) => ({ $lte: v }),
      in: (v: unknown[]) => ({ $in: v }),
      nin: (v: unknown[]) => ({ $nin: v }),
      exists: (v: boolean) => ({ $exists: v }),
      set: (v: unknown) => v,
    },
    collection: (name: string) => {
      assert.equal(name, 'catalogDetailApprovals');
      return q;
    },
  };
  assert.equal(await findUnfinishedApprovalImageInCloudBase(db, 'target', after), 'p');
  assert.deepEqual(projection, { _id: true, productId: true });
  assert.deepEqual(events, ['where', 'sort', 'limit', 'field', 'get']);
  assert.deepEqual(where, approvalImageHoldWhere(command, 'target', after));
  const text = JSON.stringify(where);
  for (const path of [
    '$publication.header.images',
    '$publication.header.descriptionImages',
    '$publication.variantImageIds',
    '$publication.header._id',
    '$productId',
  ])
    assert.ok(text.includes(path));
  assert.ok(text.includes('staging'));
  assert.ok(text.includes('approved'));
  assert.ok(text.includes(after));
  assert.ok(text.includes('"$slice"'));
  assert.ok(text.includes('"$isArray"'));
  const before = [...events];
  assert.equal(await findUnfinishedApprovalImageInCloudBase(db, 'legacy.name', after), null);
  assert.deepEqual(events, before);
});

function readField(doc: unknown, path: string): unknown {
  let current = doc;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}
function expression(input: unknown, doc: unknown): unknown {
  if (typeof input === 'string' && input.startsWith('$')) return readField(doc, input.slice(1));
  if (Array.isArray(input)) return input.map((x) => expression(x, doc));
  if (!input || typeof input !== 'object') return input;
  const entries = Object.entries(input);
  assert.equal(entries.length, 1);
  const pair = entries[0];
  assert.ok(pair);
  const [op, raw] = pair;
  if (op === '$isArray') return Array.isArray(expression(raw, doc));
  assert.ok(Array.isArray(raw));
  if (op === '$cond') return expression(raw[expression(raw[0], doc) ? 1 : 2], doc);
  const values = raw.map((x) => expression(x, doc));
  if (op === '$and') return values.every(Boolean);
  if (op === '$or') return values.some(Boolean);
  if (op === '$eq') return values[0] === values[1];
  if (op === '$in') {
    assert.ok(Array.isArray(values[1]));
    return values[1].includes(values[0]);
  }
  if (op === '$slice') {
    assert.ok(Array.isArray(values[0]));
    assert.equal(typeof values[1], 'number');
    return values[0].slice(0, Number(values[1]));
  }
  throw new Error(`Unsupported test operator ${op}`);
}
function mongoMatch(query: Record<string, unknown>, doc: CollectionDoc): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$and') {
      assert.ok(Array.isArray(value));
      return value.every((v) => mongoMatch(v, doc));
    }
    if (key === '$expr') return Boolean(expression(value, doc));
    assert.ok(value && typeof value === 'object');
    if (Object.hasOwn(value, '$eq')) return readField(doc, key) === Reflect.get(value, '$eq');
    if (Object.hasOwn(value, '$gt'))
      return String(readField(doc, key) ?? '') > String(Reflect.get(value, '$gt'));
    throw new Error('Unsupported test clause');
  });
}
for (const id of ['gallery', 'description', 'variant', 'missing'])
  for (const shape of [
    'base',
    'expired',
    'complete',
    'wrong-header',
    'missing-publication',
    'string-array',
  ] as const)
    test(`native predicate matches existing reference semantics: ${id}/${shape}`, () => {
      const value: CollectionDoc = structuredClone(row());
      if (shape === 'expired') value.createdAt = after;
      if (shape === 'complete') value.state = 'complete';
      if (shape === 'wrong-header')
        Reflect.set(value, 'publication', {
          ...row().publication,
          header: { ...row().publication.header, _id: 'other' },
        });
      if (shape === 'missing-publication') Reflect.deleteProperty(value, 'publication');
      if (shape === 'string-array')
        value.publication = {
          state: 'approved',
          header: {
            _id: 'p',
            images: '/api/images/gallery',
            descriptionImages: '/api/images/description',
          },
          variantImageIds: 'variant',
        };
      const expected = firstApprovalImageHold([value], id, after) !== null;
      assert.equal(mongoMatch(approvalImageHoldWhere(command, id, after), value), expected);
    });

for (const [place, index, expected] of [
  ['gallery', 8, true],
  ['gallery', 9, false],
  ['description', 17, true],
  ['description', 18, false],
  ['variant', 9999, true],
] as const)
  test(`native reference boundary ${place}/${index}`, () => {
    const value = row();
    const refs = Array.from({ length: index }, (_, i) =>
      place === 'variant' ? `unused${i}` : `/api/images/unused${i}`,
    );
    refs.push(place === 'variant' ? 'target' : '/api/images/target');
    if (place === 'gallery') value.publication.header.images = refs;
    if (place === 'description') value.publication.header.descriptionImages = refs;
    if (place === 'variant') value.publication.variantImageIds = refs;
    assert.equal(firstApprovalImageHold([value], 'target', after) !== null, expected);
    assert.equal(mongoMatch(approvalImageHoldWhere(command, 'target', after), value), expected);
  });
