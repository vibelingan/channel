import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteFixture } from './website-test-fixtures.ts';
import { handleAdminRequest } from '../../admin/src/handler.ts';
import { signSession } from '@vibelingan-channel/auth/jwt';
import {
  createInitialSourceDelivery,
  registrationKey,
} from '@vibelingan-channel/db/sales-inquiry-submission';
const fields = {
  company: 'Buyer',
  contact: 'Alex',
  email: 'buyer@example.invalid',
  category: 'Headphones',
  quantity: 500,
};
test('real public product submission persists one finalized source registration and exact retries stay one', async () => {
  const s = createWebsiteFixture();
  const input = s.quoteInput();
  const saved = await s.submitProduct(input);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(s.registrations().length, 1);
  assert.equal((await s.submitProduct(input)).statusCode, 200);
  assert.equal(s.registrations().length, 1);
  const registration = s.registrations()[0];
  assert.ok(registration);
  const row = s.rows.get(`catalogQuoteRequests/${registration.source.id}`);
  assert.equal(row?.salesSubmissionState, 'finalized');
  assert.equal(row?.salesSubmittedRevision, registration.source.revision);
  assert.deepEqual(
    s.rows.get(`channelSalesSourceDeliveries/${registrationKey(registration)}`)?.record,
    createInitialSourceDelivery(registration),
  );
});
test('real OEM no-file submission finalizes and registers through one transaction', async () => {
  const s = createWebsiteFixture();
  const result = await s.callOem('submitProject', fields);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(s.registrations().length, 1);
  const registration = s.registrations()[0];
  assert.ok(registration);
  assert.equal(
    s.rows.get(`oemProjects/${registration.source.id}`)?.salesSubmittedRevision,
    registration.source.revision,
  );
});
test('every public save transaction write failure leaves no inquiry or registration', async () => {
  for (const write of [1, 2, 3, 4]) {
    const s = createWebsiteFixture();
    s.setFailAtWrite(write);
    const result = await s.submitProduct();
    assert.equal(result.statusCode, 500);
    assert.equal(s.registrations().length, 0);
    assert.equal(
      [...s.rows.keys()].filter((key) => key.startsWith('channelSalesSourceDeliveries/')).length,
      0,
    );
    assert.equal(
      [...s.rows.keys()].filter((key) => key.startsWith('catalogQuoteRequests/')).length,
      0,
    );
  }
  for (const write of [1, 2, 3]) {
    const s = createWebsiteFixture();
    s.setFailAtWrite(write);
    const result = await s.callOem('submitProject', fields);
    assert.equal(result.ok, false);
    assert.equal(s.registrations().length, 0);
    assert.equal(
      [...s.rows.keys()].filter((key) => key.startsWith('channelSalesSourceDeliveries/')).length,
      0,
    );
    assert.equal([...s.rows.keys()].filter((key) => key.startsWith('oemProjects/')).length, 0);
  }
});
test('old saved product retries do not acquire ownership or a registration', async () => {
  const s = createWebsiteFixture();
  const input = s.quoteInput();
  const off = await s.submitProduct(input, null);
  assert.equal(off.statusCode, 200);
  assert.equal(s.registrations().length, 0);
  const again = await s.submitProduct(input);
  assert.equal(again.statusCode, 200);
  assert.equal(s.registrations().length, 0);
});
test('modern upload stamps trusted ownership and finalization uses sniffed bytes MIME', async () => {
  const s = createWebsiteFixture();
  const bytes = Buffer.from('%PDF-1.4\nsynthetic\n');
  const result = await s.callOem('createOemFileUploadIntent', {
    fileName: 'drawing.pdf',
    mimeType: 'text/html',
    byteSize: bytes.length,
    client_id: 'foreign',
  });
  assert.ok(result.ok, JSON.stringify(result));
  const value = result.data as { fileId: string; uploadIntentId: string; uploadSecret: string };
  const file = s.rows.get(`files/${value.fileId}`);
  assert.equal(file?.client_id, s.scope.client_id);
  assert.equal(typeof file?.storageFileId, 'string');
  s.objects.set(String(file?.storageFileId), bytes);
  const submitted = await s.callOem('submitProject', {
    ...fields,
    drawingFileId: value.fileId,
    uploadIntentId: value.uploadIntentId,
    uploadSecret: value.uploadSecret,
    client_id: 'foreign',
    salesSubmissionState: 'finalized',
  });
  assert.ok(submitted.ok, JSON.stringify(submitted));
  assert.equal(s.rows.get(`files/${value.fileId}`)?.mimeType, 'application/pdf');
  assert.equal(s.registrations().length, 1);
});

test('an unused legacy field cannot cancel capture of a valid modern upload', async () => {
  const s = createWebsiteFixture();
  const bytes = Buffer.from('%PDF-1.4\n');
  const intent = await s.callOem('createOemFileUploadIntent', {
    fileName: 'drawing.pdf',
    mimeType: 'application/pdf',
    byteSize: bytes.length,
  });
  assert.ok(intent.ok);
  const value = intent.data as { fileId: string; uploadIntentId: string; uploadSecret: string };
  const row = s.rows.get(`files/${value.fileId}`);
  assert.ok(row);
  s.objects.set(String(row.storageFileId), bytes);
  const result = await s.callOem('submitProject', {
    ...fields,
    drawingFileId: value.fileId,
    uploadIntentId: value.uploadIntentId,
    uploadSecret: value.uploadSecret,
    drawingData: Buffer.from('unused legacy payload').toString('base64'),
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(s.registrations().length, 1);
});

test('future cutover and disabled capture preserve buyer saving without new ownership or registration', async () => {
  const s = createWebsiteFixture();
  const future = { ...s.scope, cutover_at: Math.floor(Date.now() / 1000) + 3600 };
  assert.equal((await s.submitProduct(s.quoteInput(), future)).statusCode, 200);
  assert.ok((await s.callOem('submitProject', fields, future)).ok);
  assert.equal(s.registrations().length, 0);
  for (const [key, row] of s.rows)
    if (/^(oemProjects|catalogQuoteRequests)\//.test(key)) assert.equal(row.client_id, undefined);
});

test('old pending uploads and failed byte verification cannot acquire a sales registration', async () => {
  for (const old of [true, false]) {
    const s = createWebsiteFixture();
    const bytes = Buffer.from('%PDF-1.4\n');
    const intent = await s.callOem(
      'createOemFileUploadIntent',
      { fileName: 'drawing.pdf', mimeType: 'application/pdf', byteSize: bytes.length },
      old ? null : s.scope,
    );
    assert.ok(intent.ok);
    const value = intent.data as { fileId: string; uploadIntentId: string; uploadSecret: string };
    const row = s.rows.get(`files/${value.fileId}`);
    assert.ok(row);
    s.objects.set(String(row.storageFileId), old ? bytes : Buffer.from('<html>bad bytes</html>'));
    const result = await s.callOem('submitProject', {
      ...fields,
      drawingFileId: value.fileId,
      uploadIntentId: value.uploadIntentId,
      uploadSecret: value.uploadSecret,
    });
    assert.equal(result.ok, false);
    assert.equal(s.registrations().length, 0);
    assert.equal([...s.rows.keys()].filter((key) => key.startsWith('oemProjects/')).length, 0);
  }
});

test('attachment final transaction failures never leave an activated attachment or source', async () => {
  for (const write of [1, 2, 3, 4]) {
    const s = createWebsiteFixture();
    const bytes = Buffer.from('%PDF-1.4\n');
    const intent = await s.callOem('createOemFileUploadIntent', {
      fileName: 'drawing.pdf',
      mimeType: 'application/pdf',
      byteSize: bytes.length,
    });
    assert.ok(intent.ok);
    const value = intent.data as { fileId: string; uploadIntentId: string; uploadSecret: string };
    const row = s.rows.get(`files/${value.fileId}`);
    assert.ok(row);
    s.objects.set(String(row.storageFileId), bytes);
    s.setFailAtWrite(write);
    assert.equal(
      (
        await s.callOem('submitProject', {
          ...fields,
          drawingFileId: value.fileId,
          uploadIntentId: value.uploadIntentId,
          uploadSecret: value.uploadSecret,
        })
      ).ok,
      false,
    );
    assert.equal(s.rows.get(`files/${value.fileId}`)?.status, 'pending');
    assert.equal(s.registrations().length, 0);
    assert.equal([...s.rows.keys()].filter((key) => key.startsWith('oemProjects/')).length, 0);
  }
});

test('generic portal CRUD rejects every trusted ownership and finalization field', async () => {
  const s = createWebsiteFixture();
  s.install();
  s.rows.set('users/admin', {
    _id: 'admin',
    username: 'Admin',
    email: 'admin@example.invalid',
    role: 'admin',
    status: 'active',
  });
  s.rows.set('oemProjects/plain', { _id: 'plain', ...fields, status: 'new', drawing: '' });
  s.rows.set('files/plain', { _id: 'plain', name: 'plain.pdf', mimeType: 'application/pdf' });
  const token = await signSession('offline-synthetic-secret', {
    sub: 'admin',
    name: 'Admin',
    email: 'admin@example.invalid',
    role: 'admin',
  });
  for (const collection of ['oemProjects', 'files']) {
    const values =
      collection === 'oemProjects' ? { ...fields, status: 'new' } : { name: 'file.pdf' };
    assert.ok(
      (
        await handleAdminRequest(
          { action: 'create', data: { collection, values }, token },
          { jwtSecret: 'offline-synthetic-secret' },
        )
      ).ok,
    );
  }
  for (const collection of ['oemProjects', 'files'])
    for (const [key, value] of Object.entries({
      client_id: 'client_a',
      business_line: 'website_sales',
      source_installation_id: 'site_a',
      salesSubmissionState: 'finalized',
      salesSubmittedRevision: 'a'.repeat(64),
    })) {
      for (const action of ['create', 'update', 'batchUpdate']) {
        const values =
          collection === 'oemProjects'
            ? { ...fields, status: 'new', [key]: value }
            : { name: 'file.pdf', [key]: value };
        const data =
          action === 'create'
            ? { collection, values }
            : action === 'update'
              ? { collection, id: 'plain', values: { [key]: value } }
              : { collection, ids: ['plain'], values: { [key]: value } };
        const result = await handleAdminRequest(
          { action, data, token },
          { jwtSecret: 'offline-synthetic-secret' },
        );
        assert.equal(result.ok, false, `${collection}/${action}/${key}`);
      }
      assert.equal(s.rows.get(`${collection}/plain`)?.[key], undefined);
    }
  assert.equal(s.registrations().length, 0);
});

test('a concurrent upload loser cannot prevent the verified winner from completing', async () => {
  const s = createWebsiteFixture();
  const bytes = Buffer.from('%PDF-1.4\n');
  const intent = await s.callOem('createOemFileUploadIntent', {
    fileName: 'drawing.pdf',
    mimeType: 'application/pdf',
    byteSize: bytes.length,
  });
  assert.ok(intent.ok);
  const value = intent.data as { fileId: string; uploadIntentId: string; uploadSecret: string };
  const row = s.rows.get(`files/${value.fileId}`);
  assert.ok(row);
  s.objects.set(String(row.storageFileId), bytes);
  let announce = () => {},
    release = () => {};
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  s.setBeforeRead(async () => {
    announce();
    await released;
  });
  const body = {
    ...fields,
    drawingFileId: value.fileId,
    uploadIntentId: value.uploadIntentId,
    uploadSecret: value.uploadSecret,
  };
  const first = s.callOem('submitProject', body);
  await entered;
  const second = await s.callOem('submitProject', body);
  assert.equal(second.ok, false);
  release();
  assert.ok((await first).ok);
  assert.equal(s.registrations().length, 1);
  assert.equal(s.rows.get(`files/${value.fileId}`)?.finalizeClaim, 2);
});

test('an ambiguous transaction response does not corrupt an already committed OEM attachment', async () => {
  const s = createWebsiteFixture();
  const bytes = Buffer.from('%PDF-1.4\n');
  const intent = await s.callOem('createOemFileUploadIntent', {
    fileName: 'drawing.pdf',
    mimeType: 'application/pdf',
    byteSize: bytes.length,
  });
  assert.ok(intent.ok);
  const value = intent.data as { fileId: string; uploadIntentId: string; uploadSecret: string };
  const row = s.rows.get(`files/${value.fileId}`);
  assert.ok(row);
  s.objects.set(String(row.storageFileId), bytes);
  s.setFailAfterCommit(true);
  const result = await s.callOem('submitProject', {
    ...fields,
    drawingFileId: value.fileId,
    uploadIntentId: value.uploadIntentId,
    uploadSecret: value.uploadSecret,
  });
  assert.equal(result.ok, false);
  assert.equal(s.rows.get(`files/${value.fileId}`)?.status, 'active');
  assert.equal(s.registrations().length, 1);
});
