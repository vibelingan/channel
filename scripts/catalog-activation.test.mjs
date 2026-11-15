import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateAcceptedCatalogRegistration,
  activateCatalogRenderer,
} from './release/catalog-activation.mjs';
const proof = { codeSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
function fixture() {
  let record;
  const events = [];
  const input = {
    proof,
    runId: 'site-101-1',
    executorSha: 'c'.repeat(40),
    executorRef: 'feat/seo-foundation',
    db: {
      collection(name) {
        assert.equal(name, 'catalogSeoBuilders');
        return {
          doc(id) {
            assert.equal(id, 'active');
            return {
              set: async (data) => {
                events.push('program');
                record = { ...data, _id: id };
              },
              get: async () => ({ data: record ? [record] : [] }),
            };
          },
        };
      },
    },
  };
  return { input, events };
}
test('product-page acceptance finishes before the clock program changes', async () => {
  const x = fixture();
  const result = await activateCatalogRenderer({
    ...x.input,
    writeActive: (data) => x.input.db.collection('catalogSeoBuilders').doc('active').set(data),
    finishCatalog: async () => {
      x.events.push('pages');
    },
  });
  assert.deepEqual(x.events, ['pages', 'program']);
  assert.equal(result.catalogTracked, true);
});
test('failed page acceptance cannot make an unfinished program active', async () => {
  const x = fixture();
  await assert.rejects(
    activateCatalogRenderer({
      ...x.input,
      writeActive: (data) => x.input.db.collection('catalogSeoBuilders').doc('active').set(data),
      finishCatalog: async () => {
        throw Error('page write failed');
      },
    }),
    /page write failed/,
  );
  assert.deepEqual(x.events, []);
});
test('an untracked manual site build cannot authorize automatic updates', async () => {
  const x = fixture();
  const result = await activateCatalogRenderer(x.input);
  assert.equal(result.catalogTracked, false);
});
test('missing readback cannot authorize the program', async () => {
  const x = fixture();
  x.input.db.collection = () => ({
    doc: () => ({
      set: async () => {
        throw Error('lost reply');
      },
      get: async () => ({ data: [] }),
    }),
  });
  await assert.rejects(activateCatalogRenderer(x.input), /needs readback/);
});

test('regional registration sends only accepted identities and compares the exact result', async () => {
  const input = { envelope: { artifact: { artifactId: '123' } }, acceptedSeal: { state: 'fixed' } };
  const renderer = { codeSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
  const data = { acceptedRunId: 'site-101-1', catalogTracked: true };
  const calls = [];
  const regional = {
    activateAcceptedRegistration: async (request) => {
      calls.push(request);
      return { registered: true, active: { ...data } };
    },
  };
  await activateAcceptedCatalogRegistration({
    regional,
    input,
    renderer,
    executorRef: 'feat/seo-foundation',
    expectedWrites: 4,
    data,
  });
  assert.deepEqual(calls, [
    {
      artifact: input.envelope.artifact,
      acceptedSeal: input.acceptedSeal,
      renderer,
      executorRef: 'feat/seo-foundation',
      expectedWrites: 4,
    },
  ]);
  for (const response of [
    { registered: false, active: data },
    { registered: true, active: { ...data, catalogTracked: false } },
    { registered: true, active: { ...data, acceptedRunId: 'site-100-1' } },
  ]) {
    regional.activateAcceptedRegistration = async () => response;
    await assert.rejects(
      activateAcceptedCatalogRegistration({
        regional,
        input,
        renderer,
        executorRef: 'feat/seo-foundation',
        expectedWrites: 4,
        data,
      }),
      { code: 'CATALOG_REGIONAL_ACTIVATION_MISMATCH' },
    );
  }
});
