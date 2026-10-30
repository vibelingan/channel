import { randomBytes } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const state = randomBytes(32).toString('hex');
const directory = join(homedir(), '.config/channel-catalog-seo');
await mkdir(directory, { recursive: true, mode: 0o700 });
const privateFile = join(directory, 'github-app.json');
try {
  await lstat(privateFile);
  throw Error(
    'A local GitHub App credential already exists. Inspect that application; do not create another one.',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
let used = false;
const server = createServer(async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
    res.writeHead(400).end('Invalid host');
    return;
  }
  if (url.pathname === `/setup/${state}` && req.method === 'GET') {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const manifest = {
      name: 'Channel Catalog HTML Delivery',
      url: 'https://github.com/vibelingan/channel',
      redirect_url: `${origin}/callback`,
      public: false,
      hook_attributes: { active: false },
      default_permissions: { actions: 'write', contents: 'read' },
      default_events: [],
    };
    const value = JSON.stringify(manifest)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<html lang="zh-CN"><title>商品网页自动更新授权</title><body style="font:18px/1.7 system-ui;max-width:760px;margin:64px auto;padding:24px"><h1>只给 channel 仓库开通自动更新</h1><p>这个专用应用让腾讯云在商品变化后启动 GitHub 网页构建。它申请 Actions 写权限（启动工作流）和源码读取，不申请源码修改、仓库管理或其他应用权限。</p><p>下一页请使用 vibelingan 账号创建应用，再安装到 <b>Only select repositories → channel</b>。私钥自动保存在这台 Mac 的私人配置目录，不显示在聊天中。</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${value}"><button style="font-size:20px;padding:12px">查看 GitHub 授权范围</button></form></body></html>`,
    );
    return;
  }
  if (
    url.pathname === '/callback' &&
    req.method === 'GET' &&
    !used &&
    url.searchParams.get('state') === state &&
    /^[a-zA-Z0-9_-]{10,200}$/.test(url.searchParams.get('code') ?? '')
  ) {
    used = true;
    try {
      const result = await fetch(
        `https://api.github.com/app-manifests/${url.searchParams.get('code')}/conversions`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        },
      );
      if (!result.ok) throw Error('GitHub conversion failed');
      const data = await result.json();
      if (
        !Number.isSafeInteger(data.id) ||
        !data.pem?.includes('PRIVATE KEY') ||
        !/^https:\/\/github.com\/apps\/[a-z0-9-]+$/.test(data.html_url)
      )
        throw Error('Invalid application response');
      await writeFile(
        privateFile,
        JSON.stringify({
          schemaVersion: 1,
          repository: 'vibelingan/channel',
          appId: data.id,
          privateKey: data.pem,
          appUrl: data.html_url,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        `<html lang="zh-CN"><title>应用已创建</title><body><h1>应用已创建，私钥已安全保存</h1><p>还需要安装：只选择 channel 仓库。</p><a href="${data.html_url}/installations/new">安装到 channel 仓库</a></body></html>`,
      );
      console.log(
        'Application created; private key saved outside the repository. Finish repository-only installation in the browser.',
      );
    } catch {
      res
        .writeHead(502)
        .end(
          'Application setup did not finish. Do not repeat creation; check the existing app and local private file first.',
        );
      console.error('Application setup needs readback; no credential details logged.');
    }
    return;
  }
  res.writeHead(404).end('Not found');
});
server.listen(0, '127.0.0.1', () =>
  console.log(`http://127.0.0.1:${server.address().port}/setup/${state}`),
);
setTimeout(() => server.close(), 3600000).unref();
