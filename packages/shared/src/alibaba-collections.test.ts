import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { Role } from './auth.ts';
import type { FieldDef } from './collections.ts';
import {
  ALIBABA_SOURCE_STATUS_OPTIONS,
  COLLECTIONS,
  adminVisibleCollections,
  buildWriteSchema,
  canEditRegisteredCollection,
  canReadRegisteredCollection,
  collectionAdminAccess,
  getCollection,
  writableFields,
} from './collections.ts';

// --- registry contract (MIU 3) ---------------------------------------------

const EXPECTED_ACCESS: Record<string, 'crud' | 'readOnly' | 'none'> = {
  alibabaConnections: 'none',
  alibabaOAuthStates: 'none',
  alibabaSyncLeases: 'none',
  alibabaSyncCheckpoints: 'none',
  alibabaSourcePayloads: 'readOnly',
  alibabaSourceProducts: 'readOnly',
  alibabaProductLinks: 'readOnly',
  alibabaSupplierOffers: 'readOnly',
  alibabaSyncRuns: 'readOnly',
  alibabaCategoryMappings: 'crud',
};

test('all ten Alibaba collections are registered with the charter access levels', () => {
  for (const [name, access] of Object.entries(EXPECTED_ACCESS)) {
    const def = getCollection(name);
    assert.ok(def, `${name} must be registered`);
    assert.equal(collectionAdminAccess(name), access, name);
  }
});

test('non-crud Alibaba collections are hidden from nav and fully server-managed', () => {
  for (const [name, access] of Object.entries(EXPECTED_ACCESS)) {
    if (access === 'crud') continue;
    const def = getCollection(name);
    assert.ok(def);
    assert.equal(def.hideFromNav, true, `${name} must be hideFromNav`);
    for (const field of def.fields) {
      assert.equal(field.readOnly, true, `${name}.${field.name} must be readOnly`);
    }
    assert.equal(writableFields(def).length, 0, `${name} must have no writable fields`);
  }
});

test('category mapping is operator-writable with the Channel category enum', () => {
  const def = getCollection('alibabaCategoryMappings');
  assert.ok(def);
  const names = writableFields(def).map((f) => f.name);
  assert.deepEqual(names.sort(), [
    'alibabaCategoryId',
    'alibabaCategoryLabel',
    'channelCategory',
    'notes',
  ]);
  const schema = buildWriteSchema(def);
  assert.equal(
    schema.safeParse({ alibabaCategoryId: 'c-1', channelCategory: 'bluetooth' }).success,
    true,
  );
  assert.equal(
    schema.safeParse({ alibabaCategoryId: 'c-1', channelCategory: 'garden' }).success,
    false,
  );
});

// --- additive product fields ------------------------------------------------

const ALIBABA_PRODUCT_FIELDS = [
  'alibabaPrimarySourceKey',
  'alibabaPrimaryOfferKey',
  'alibabaCatalogPricing',
  'alibabaSourceStatus',
  'alibabaSourceLastSyncedAt',
];

test('products gains the five additive Alibaba fields, all read-only', () => {
  const def = getCollection('products');
  assert.ok(def);
  for (const name of ALIBABA_PRODUCT_FIELDS) {
    const field: FieldDef | undefined = def.fields.find((f) => f.name === name);
    assert.ok(field, `products.${name} must exist`);
    assert.equal(field.readOnly, true, `products.${name} must be readOnly`);
  }
  const status = def.fields.find((f) => f.name === 'alibabaSourceStatus');
  assert.deepEqual(status?.options, ALIBABA_SOURCE_STATUS_OPTIONS);
});

test('generic write schema rejects Alibaba fields as unknown keys', () => {
  const def = getCollection('products');
  assert.ok(def);
  const schema = buildWriteSchema(def);
  const result = schema.safeParse({
    name: 'X',
    category: 'bluetooth',
    alibabaPrimarySourceKey: 'k',
  });
  assert.equal(result.success, false, 'readOnly field must be rejected on generic write');
});

// --- protected legacy pricing surfaces (EXECUTION_HANDOFF §3 snapshot) ------

test('SNAPSHOT: legacy pricing field definitions are byte-identical to the pre-feature contract', () => {
  const products = getCollection('products');
  const overstock = getCollection('overstock');
  assert.ok(products && overstock);
  assert.deepEqual(
    products.fields.filter((f) =>
      ['unitPrice', 'wholesalePrice', 'vipPrice', 'moq'].includes(f.name),
    ),
    [
      { name: 'moq', label: 'MOQ', type: 'number' },
      { name: 'unitPrice', label: 'Unit Price', type: 'number' },
      { name: 'wholesalePrice', label: 'Wholesale Price', type: 'number' },
      { name: 'vipPrice', label: 'VIP Price', type: 'number' },
    ],
  );
  assert.deepEqual(
    overstock.fields.filter((f) =>
      ['unitPrice', 'clearancePrice', 'wholesalePrice', 'vipPrice'].includes(f.name),
    ),
    [
      { name: 'unitPrice', label: 'Unit Price', type: 'number' },
      { name: 'clearancePrice', label: 'Clearance Price', type: 'number' },
      { name: 'wholesalePrice', label: 'Wholesale Price', type: 'number' },
      { name: 'vipPrice', label: 'VIP Price', type: 'number' },
    ],
  );
  // Overstock carries NO Alibaba fields — the feature never touches it.
  assert.equal(
    overstock.fields.some((f) => f.name.startsWith('alibaba')),
    false,
  );
});

// --- access matrix (R1) ------------------------------------------------------

const ROLES_TO_CHECK: Role[] = ['admin', 'contributor', 'member', 'viewer', ''];

test('generic-CRUD access matrix honors adminAccess for every role', () => {
  for (const role of ROLES_TO_CHECK) {
    const contentRole = role === 'admin' || role === 'contributor';
    // none: invisible to everyone
    assert.equal(
      canReadRegisteredCollection(role, 'alibabaConnections'),
      false,
      `${role} read none`,
    );
    assert.equal(
      canEditRegisteredCollection(role, 'alibabaConnections'),
      false,
      `${role} edit none`,
    );
    // readOnly: content roles may read, nobody may write
    assert.equal(
      canReadRegisteredCollection(role, 'alibabaSyncRuns'),
      contentRole,
      `${role} read readOnly`,
    );
    assert.equal(
      canEditRegisteredCollection(role, 'alibabaSyncRuns'),
      false,
      `${role} edit readOnly`,
    );
    // crud: unchanged content-role semantics
    assert.equal(
      canReadRegisteredCollection(role, 'alibabaCategoryMappings'),
      contentRole,
      `${role} read crud`,
    );
    assert.equal(
      canEditRegisteredCollection(role, 'alibabaCategoryMappings'),
      contentRole,
      `${role} edit crud`,
    );
  }
});

test('REGRESSION: hardcoded admin-only trio is preserved unchanged', () => {
  for (const name of ['users', 'rateLimitHits', 'passwordResets']) {
    assert.equal(canReadRegisteredCollection('admin', name), true, `admin read ${name}`);
    assert.equal(canEditRegisteredCollection('admin', name), true, `admin edit ${name}`);
    assert.equal(
      canReadRegisteredCollection('contributor', name),
      false,
      `contributor read ${name}`,
    );
    assert.equal(
      canEditRegisteredCollection('contributor', name),
      false,
      `contributor edit ${name}`,
    );
  }
  // Pre-existing content collections keep contributor access.
  assert.equal(canEditRegisteredCollection('contributor', 'products'), true);
  assert.equal(canReadRegisteredCollection('contributor', 'products'), true);
});

test('admin-visible registry dump omits none collections and keeps the rest', () => {
  const visible = adminVisibleCollections().map((d) => d.name);
  for (const [name, access] of Object.entries(EXPECTED_ACCESS)) {
    assert.equal(visible.includes(name), access !== 'none', name);
  }
  assert.equal(
    visible.length,
    COLLECTIONS.length - 4,
    'exactly the four none collections are omitted',
  );
});
