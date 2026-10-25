import assert from 'node:assert/strict';
import test from 'node:test';
import { setBlogRoutes } from './blog/server-routes.mjs';
function fixture() {
  const site = {
    Domain: 'supplychainsai.com',
    DomainType: 'HTTPSERVICE',
    Enable: true,
    Extension: {
      HeadersHandler: { ResponseHeadersToAdd: [{ Key: 'Cache-Control', Value: 'no-cache' }] },
    },
    Routes: [
      {
        Path: '/',
        UpstreamResourceType: 'STATIC_STORE',
        UpstreamResourceName: 'staticstore',
        Enable: true,
      },
      {
        Path: '/*',
        UpstreamResourceType: 'STATIC_STORE',
        UpstreamResourceName: 'staticstore',
        Enable: true,
      },
    ],
  };
  const writes = [];
  const records = [];
  let loseAck = false;
  let rejectWrite = false;
  let drift = false;
  let verified = 0;
  const client = {
    async call(name, input) {
      if (name === 'queryGateway') return { data: { raw: { Domains: [structuredClone(site)] } } };
      assert.equal(name, 'manageGateway');
      assert.equal(input.domain, 'supplychainsai.com');
      assert(['/blog', '/blog/*'].includes(input.path));
      writes.push(input);
      if (rejectWrite) throw Error('not submitted');
      const existing = site.Routes.find((route) => route.Path === input.path);
      if (input.action === 'createRoute') {
        assert.equal(input.enablePathTransmission, true);
        assert.equal(input.upstreamResourceType, 'CBR');
        assert.equal(input.targetName, 'blog-pages');
        site.Routes.push({
          Path: input.path,
          UpstreamResourceType: 'CBR',
          UpstreamResourceName: input.targetName,
          Enable: true,
          EnableAuth: false,
          EnablePathTransmission: true,
        });
      } else existing.Enable = input.action === 'enableRoute';
      if (drift) site.Extension.HeadersHandler.ResponseHeadersToAdd[0].Value = 'other writer';
      if (loseAck) throw Error('acknowledgement lost');
      return { success: true };
    },
  };
  return {
    site,
    writes,
    records,
    client,
    loseAck() {
      loseAck = true;
    },
    rejectWrite() {
      rejectWrite = true;
    },
    drift() {
      drift = true;
    },
    run: (action) =>
      setBlogRoutes({
        client,
        action,
        save: async (record) => {
          records.push(structuredClone(record));
        },
        verify: async () => {
          verified++;
        },
      }),
    verified: () => verified,
  };
}
test('A → Blog routes B → A disables only its own routes; original site and headers stay intact', async () => {
  const f = fixture();
  const original = structuredClone(f.site);
  await f.run('initialize');
  assert.equal(f.writes.length, 2);
  assert.equal(f.verified(), 1);
  assert.deepEqual(f.site.Routes.slice(0, 2), original.Routes);
  assert.deepEqual(f.site.Extension, original.Extension);
  await f.run('initialize');
  assert.equal(f.writes.length, 2);
  await f.run('restore');
  assert.equal(f.writes.length, 4);
  assert(f.site.Routes.slice(2).every((route) => route.Enable === false));
  assert.deepEqual(f.site.Routes.slice(0, 2), original.Routes);
  assert(
    f.writes.every(
      (write) => !['deleteRoute', 'deleteCustomDomain', 'updateRoute'].includes(write.action),
    ),
  );
});
test('lost acknowledgement is resolved from the route; each write is submitted once', async () => {
  const f = fixture();
  f.loseAck();
  await f.run('initialize');
  assert.equal(f.writes.length, 2);
  assert.equal(f.records.at(-1).phase, 'accepted');
});
test('rejected first write stops without creating the second path or claiming acceptance', async () => {
  const f = fixture();
  f.rejectWrite();
  await assert.rejects(f.run('initialize'), /not confirmed/);
  assert.equal(f.writes.length, 1);
  assert.equal(f.verified(), 0);
  assert.equal(f.records.at(-1).phase, 'intent');
});
test('another upstream at the Blog path is preserved', async () => {
  const f = fixture();
  f.site.Routes.push({
    Path: '/blog/*',
    UpstreamResourceType: 'WEB_SCF',
    UpstreamResourceName: 'other',
    Enable: true,
  });
  await assert.rejects(f.run('initialize'), /another upstream/);
  assert.equal(f.writes.length, 0);
});
test('unrelated domain drift stops the next write and never overwrites the other writer', async () => {
  const f = fixture();
  f.drift();
  await assert.rejects(f.run('initialize'), /Unrelated domain/);
  assert.equal(f.writes.length, 1);
  assert.equal(f.site.Extension.HeadersHandler.ResponseHeadersToAdd[0].Value, 'other writer');
});
test('missing existing website refuses route creation', async () => {
  const f = fixture();
  f.site.Routes = [];
  await assert.rejects(f.run('initialize'), /existing website/);
  assert.equal(f.writes.length, 0);
});
