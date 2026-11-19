import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageBlogServer } from './blog/package-server.mjs';
import { selectBlogTransitionProgram } from './blog/prepare-asset-transition.mjs';
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
    archiveBefore: async () => ({ artifactId: '123', sha256: 'a'.repeat(64) }),
    save: async () => saves.push(structuredClone(record)),
    client: {
      call: async (name, input, options) => {
        calls.push({ name, input, options });
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
  f.client.call = async (name, input, options) => {
    if (name === 'queryCloudRun' && input.action === 'detail') {
      f.calls.push({ name, input });
      return { data: online() };
    }
    return original(name, input, options);
  };
  await submitBlogServer({
    ...f,
    operation: 'update',
    prepareUpdate: async () => ({
      phase: 'preload',
      directory: '/tmp/preload',
      missingAssets: ['client/_astro/new.css'],
    }),
  });
  assert.match(f.saves[0].before.imageUrl, /blog-pages-001-/);
  assert.equal(f.saves[0].status, 'recovery-input-saved');
  const write = f.calls.find((x) => x.name === 'manageCloudRun');
  assert.equal(write.input.serverConfig, undefined);
  assert.equal(write.input.targetPath, '/tmp/preload');
  assert.deepEqual(write.options, { timeoutMs: 360_000 });
  assert(
    f.calls
      .filter((call) => call.name === 'queryCloudRun')
      .every((call) => call.options === undefined),
  );
  assert.equal(f.saves.at(-1).assetTransition.phase, 'preload');
  assert(!JSON.stringify(f.saves).includes('DO_NOT_WRITE_REDACTED_ENV'));
});

test('an update preloads missing assets while preserving both programs and fails on corrupt live bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'channel-blog-transition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteOrigin = 'https://supplychainsai.com';
  const make = async (name, codeSha, style, body = style) => {
    const source = join(root, `src-${name}`);
    await mkdir(join(source, 'server'), { recursive: true });
    await mkdir(join(source, 'client/_astro'), { recursive: true });
    await writeFile(join(source, 'server/entry.mjs'), name);
    await writeFile(join(source, 'client/_astro', style), body);
    const directory = join(root, name);
    await packageBlogServer({ source, destination: directory, codeSha, siteOrigin });
    return { directory, codeSha };
  };
  const current = await make('old', 'a'.repeat(40), 'old.css');
  const candidate = await make('new', 'b'.repeat(40), 'new.css');
  const reply = async (_, url) => ({
    status: 200,
    body: Buffer.from(new URL(url).pathname.split('/').at(-1)),
  });
  const select = (name, request, next = candidate) =>
    selectBlogTransitionProgram({
      current,
      candidate: next,
      destination: join(root, name),
      siteOrigin,
      request,
    });

  const preload = await select('first', (method, url) =>
    url.endsWith('/new.css') ? { status: 404 } : reply(method, url),
  );
  assert.equal(preload.phase, 'preload');
  assert.deepEqual(preload.missingAssets, ['client/_astro/new.css']);
  assert.equal(await readFile(join(preload.directory, 'server/entry.mjs'), 'utf8'), 'old');
  assert.equal(await readFile(join(preload.directory, 'client/_astro/new.css'), 'utf8'), 'new.css');

  const ready = await select('second', reply);
  assert.equal(ready.phase, 'candidate');
  assert.equal(await readFile(join(ready.directory, 'server/entry.mjs'), 'utf8'), 'new');
  assert.equal(await readFile(join(ready.directory, 'client/_astro/old.css'), 'utf8'), 'old.css');

  await assert.rejects(
    select('bad-live', async () => ({ status: 200, body: Buffer.from('bad.css') })),
    /did not serve the expected asset/,
  );
  const conflict = await make('conflict', 'c'.repeat(40), 'old.css', 'bad.css');
  await assert.rejects(select('collision', reply, conflict), /changed without a new URL/);
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

test('failed recovery archive or changed old image prevents an existing service update', async () => {
  for (const fault of ['archive', 'changed-image']) {
    const f = fixture({ exists: true });
    let reads = 0;
    const original = f.client.call;
    f.client.call = async (name, input) => {
      if (name === 'queryCloudRun' && input.action === 'detail') {
        const data = online();
        reads++;
        if (fault === 'changed-image' && reads > 1) data.latestDeploy.RunId = 'another-run';
        return { data };
      }
      return original(name, input);
    };
    if (fault === 'archive')
      f.archiveBefore = async () => {
        throw Error('Archive unavailable');
      };
    await assert.rejects(submitBlogServer({ ...f, operation: 'update' }));
    assert(f.calls.every((x) => x.name === 'queryCloudRun'));
  }
});
