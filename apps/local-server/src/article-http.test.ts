import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test(
  'the real local HTTP entry saves private drafts with conflict status and no-store caching',
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'channel-article-http-'));
    const database = join(directory, 'db.json');
    const readyFile = join(directory, 'ready.json');
    const readyToken = randomUUID();
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./main.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          PORT: '0',
          LOCAL_DB_FILE: database,
          LOCAL_MEDIA_DIR: join(directory, 'media'),
          LOCAL_READY_FILE: readyFile,
          LOCAL_READY_TOKEN: readyToken,
          TCB_ENV: '',
          ALI_APP_KEY: '',
          ALI_APP_SECRET: '',
          ADMIN_EMAIL: 'admin@channel.local',
          ADMIN_PASSWORD: 'admin',
          JWT_SECRET: 'article-http-local-test-secret',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((resolve) => child.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      await rm(directory, { recursive: true, force: true });
    });
    let origin = '';
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, `Owned API exited before readiness: ${output}`);
      try {
        const ready = JSON.parse(await readFile(readyFile, 'utf8'));
        assert.equal(ready.token, readyToken);
        assert.equal(ready.db, database);
        if (Number.isSafeInteger(ready.port) && ready.port > 0) {
          origin = `http://127.0.0.1:${ready.port}`;
          break;
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(origin, `Owned API did not become ready: ${output}`);
    const call = (body: unknown) =>
      fetch(`${origin}/api/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const login = await call({
      action: 'login',
      data: { email: 'admin@channel.local', password: 'admin' },
    });
    const session = (await login.json()) as { ok: boolean; data: { token: string } };
    assert.equal(session.ok, true);
    const token = session.data.token;
    const content = {
      title: 'HTTP draft',
      slug: '',
      body: { schemaVersion: 1, document: { type: 'doc', content: [] } },
    };
    const request = {
      action: 'articleDrafts',
      token,
      data: { operation: 'create', requestId: 'http-create', content },
    };
    const response = await call(request);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('cache-control'),
      'no-store',
      'Private drafts must not be cached',
    );
    const created = (await response.json()) as { ok: boolean; data: { id: string } };
    assert.equal(created.ok, true);
    const replay = await call(request);
    assert.deepEqual(await replay.json(), created);
    const saveRequest = {
      action: 'articleDrafts',
      token,
      data: {
        operation: 'save',
        articleId: created.data.id,
        expectedRevision: 1,
        content: { ...content, title: 'HTTP saved draft' },
      },
    };
    assert.equal((await call(saveRequest)).status, 200);
    const conflict = await call(saveRequest);
    const failure = (await conflict.json()) as { error: { code: string; currentRevision: number } };
    assert.equal(conflict.status, 409, JSON.stringify(failure));
    assert.equal(failure.error.code, 'CONFLICT');
    assert.equal(failure.error.currentRevision, 2);
    const anonymous = await call({ action: 'articleDrafts', data: { operation: 'list' } });
    assert.equal(anonymous.status, 401);
  },
);
