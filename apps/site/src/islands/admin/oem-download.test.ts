import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OemFileDownload } from './api.ts';
import { type OemDownloadDeps, downloadOemFile } from './oem-download.ts';

function fakeContract(overrides: Partial<OemFileDownload> = {}): OemFileDownload {
  return {
    fileId: 'file-1',
    url: 'https://cos.example.com/oem/file-1?sign=abc',
    fileName: 'customer-drawing.pdf',
    mimeType: 'application/pdf',
    contentDisposition: 'attachment; filename="customer-drawing.pdf"',
    ...overrides,
  };
}

test('downloadOemFile fetches the minted URL and saves it under the RETURNED filename', async () => {
  const seen: { fileId?: string; url?: string; saved?: { name: string; blob: Blob } } = {};
  const bytes = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
  const deps: OemDownloadDeps = {
    getDownloadUrl: async (fileId) => {
      seen.fileId = fileId;
      return fakeContract();
    },
    fetchBytes: async (url) => {
      seen.url = url;
      return bytes;
    },
    saveBlob: (blob, name) => {
      seen.saved = { name, blob };
    },
  };

  await downloadOemFile('file-1', deps);

  assert.equal(seen.fileId, 'file-1');
  // The temp URL is fetched (not navigated to), so image/PDF drawings download instead of inline-rendering.
  assert.equal(seen.url, 'https://cos.example.com/oem/file-1?sign=abc');
  // The click path honours the returned filename contract, not the opaque storage key.
  assert.equal(seen.saved?.name, 'customer-drawing.pdf');
  assert.equal(seen.saved?.blob, bytes);
});

test('downloadOemFile falls back to a safe name when the contract omits one', async () => {
  let savedName = '';
  const deps: OemDownloadDeps = {
    getDownloadUrl: async () => fakeContract({ fileName: '' }),
    fetchBytes: async () => new Blob(['x']),
    saveBlob: (_blob, name) => {
      savedName = name;
    },
  };

  await downloadOemFile('file-1', deps);

  assert.equal(savedName, 'oem-drawing');
});

test('downloadOemFile surfaces a fetch/CORS failure and never saves a partial file', async () => {
  let saved = false;
  const deps: OemDownloadDeps = {
    getDownloadUrl: async () => fakeContract(),
    fetchBytes: async () => {
      throw new Error('Download failed (403)');
    },
    saveBlob: () => {
      saved = true;
    },
  };

  await assert.rejects(() => downloadOemFile('file-1', deps), /Download failed \(403\)/);
  assert.equal(saved, false);
});

test('downloadOemFile surfaces a mint failure and never fetches or saves', async () => {
  let fetched = false;
  let saved = false;
  const deps: OemDownloadDeps = {
    getDownloadUrl: async () => {
      throw new Error('UNAUTHORIZED');
    },
    fetchBytes: async () => {
      fetched = true;
      return new Blob();
    },
    saveBlob: () => {
      saved = true;
    },
  };

  await assert.rejects(() => downloadOemFile('file-1', deps), /UNAUTHORIZED/);
  assert.equal(fetched, false);
  assert.equal(saved, false);
});
