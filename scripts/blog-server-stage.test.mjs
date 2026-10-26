import assert from 'node:assert/strict';
import test from 'node:test';
import { submitBlogServer } from './blog/server-stage.mjs';
function fixture({ exists = false, lostReply = false, incomplete = false } = {}) {
  const calls = [];
  const saves = [];
  const record = {
    envId: 'diversity-123-d9grnqfux221323bb',
    serverName: 'blog-pages',
    codeSha: 'a'.repeat(40),
    siteOrigin: 'https://supplychainsai.com',
    status: 'not-written',
  };
  return {
    calls,
    saves,
    record,
    directory: '/tmp/reviewed-blog-package',
    save: async () => saves.push(structuredClone(record)),
    client: {
      call: async (name, input) => {
        calls.push({ name, input });
        if (name === 'queryCloudRun')
          return {
            data: {
              services: exists ? [{ ServerName: 'blog-pages' }] : [],
              pagination: { total: incomplete ? 1000 : exists ? 1 : 0 },
            },
          };
        if (lostReply) throw Error('reply lost');
        return { success: true, message: 'submitted', data: { buildId: 123 } };
      },
    },
  };
}
test('first stage writes intent before one submission and cannot modify existing site or functions', async () => {
  const f = fixture();
  await submitBlogServer(f);
  assert.equal(f.record.status, 'submitted');
  assert.equal(f.saves[0].status, 'submitting');
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['queryCloudRun', 'manageCloudRun'],
  );
  const input = f.calls[1].input;
  assert.equal(input.serverName, 'blog-pages');
  assert.equal(input.serverConfig.MinNum, 0);
  assert.equal(input.serverConfig.MaxNum, 1);
  assert.deepEqual(JSON.parse(input.serverConfig.EnvParams), {
    BLOG_API_ORIGIN: 'https://supplychainsai.com',
    BLOG_PREVIEW_ONLY: '1',
  });
  assert(!JSON.stringify(f.calls).includes('JWT_SECRET'));
});
test('a lost submission response is unknown and never triggers a duplicate deployment', async () => {
  const f = fixture({ lostReply: true });
  await assert.rejects(submitBlogServer(f), /reply lost/);
  assert.equal(f.record.status, 'outcome-unknown');
  assert.equal(f.calls.filter((c) => c.name === 'manageCloudRun').length, 1);
  assert.equal(f.saves.at(-1).status, 'outcome-unknown');
});
test('existing service, incomplete inventory or another target stops before cloud writes', async () => {
  for (const options of [{ exists: true }, { incomplete: true }]) {
    const f = fixture(options);
    await assert.rejects(submitBlogServer(f));
    assert(f.calls.every((c) => c.name === 'queryCloudRun'));
  }
  const f = fixture();
  f.record.envId = 'another-environment';
  await assert.rejects(submitBlogServer(f), /target/);
  assert.equal(f.calls.length, 0);
});
test('failure to persist intent prevents the submission', async () => {
  const f = fixture();
  f.save = async () => {
    throw Error('archive unavailable');
  };
  await assert.rejects(submitBlogServer(f), /archive unavailable/);
  assert(f.calls.every((c) => c.name === 'queryCloudRun'));
});
function online() {
  const image =
    'ccr.ccs.tencentyun.com/tcb-100049822712-zswf/ca-lhdcoaiq_blog-pages:blog-pages-001-20261026035940';
  return {
    service: {
      BaseInfo: { ServerName: 'blog-pages', Status: 'normal', ServerType: 'container' },
      ServerConfig: {
        EnvId: 'diversity-123-d9grnqfux221323bb',
        ServerName: 'blog-pages',
        Cpu: 0.25,
        Mem: 0.5,
        MinNum: 1,
        MaxNum: 1,
        Port: 3000,
        OpenAccessTypes: ['PUBLIC'],
        EnvParams: 'DO_NOT_WRITE_REDACTED_ENV',
      },
      OnlineVersionInfos: [{ VersionName: 'blog-pages-001', ImageUrl: image, FlowRatio: '100' }],
    },
    latestDeploy: {
      Status: 'normal',
      IsReleasing: false,
      HasTraffic: true,
      ImageUrl: image,
      RunId: 'old-run',
    },
  };
}
test('explicit update persists the actual old image before one submission, without replacing configuration', async () => {
  const f = fixture({ exists: true });
  const original = f.client.call;
  f.client.call = async (name, input) => {
    if (name === 'queryCloudRun' && input.action === 'detail') {
      f.calls.push({ name, input });
      return { data: online() };
    }
    return original(name, input);
  };
  await submitBlogServer({ ...f, operation: 'update' });
  assert.match(f.saves[0].before.imageUrl, /blog-pages-001-/);
  assert.equal(f.saves[0].status, 'recovery-input-saved');
  const write = f.calls.find((x) => x.name === 'manageCloudRun');
  assert.equal(write.input.serverConfig, undefined);
  assert(!JSON.stringify(f.saves).includes('DO_NOT_WRITE_REDACTED_ENV'));
});
test('in-flight or unexpected service settings stop an update before writes', async () => {
  for (const mutate of [
    (data) => {
      data.latestDeploy.IsReleasing = true;
    },
    (data) => {
      data.service.ServerConfig.MinNum = 0;
    },
  ]) {
    const f = fixture({ exists: true });
    const original = f.client.call;
    f.client.call = async (name, input) => {
      if (name === 'queryCloudRun' && input.action === 'detail') {
        const data = online();
        mutate(data);
        return { data };
      }
      return original(name, input);
    };
    await assert.rejects(submitBlogServer({ ...f, operation: 'update' }));
    assert(f.calls.every((x) => x.name === 'queryCloudRun'));
  }
});
