import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const engine of ['chromium', 'webkit'] as const)
  test(
    `actual ${engine} storage retains original scopes across reload and tabs, with explicit blocked-storage fallback`,
    { timeout: 60000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'channel-publication-journal-browser-'));
      let closeBrowser = async () => {};
      let closeServer = async () => {};
      t.after(async () => {
        await closeBrowser();
        await closeServer();
        await rm(directory, { recursive: true, force: true });
      });
      const { createServer } = await import('vite');
      const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('../../../', import.meta.url)),
        cacheDir: join(directory, 'vite'),
        optimizeDeps: {
          entries: ['src/islands/admin/catalog-publication-journal.ts'],
          include: ['zod'],
        },
        plugins: [
          {
            name: 'publication-recovery-test-page',
            configureServer(server) {
              server.middlewares.use('/publication-recovery-test', (_request, response) => {
                response.setHeader('Content-Type', 'text/html');
                response.end(
                  '<!doctype html><html lang="en"><meta charset="utf-8"><body>Publication recovery storage test</body></html>',
                );
              });
            },
          },
        ],
        server: { host: '127.0.0.1', port: 0 },
      });
      closeServer = () => server.close();
      await server.listen();
      const origin = server.resolvedUrls?.local[0];
      assert.ok(origin);
      const { chromium, webkit } = await import('@playwright/test');
      const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true });
      closeBrowser = () => browser.close();
      const context = await browser.newContext();
      const a = await context.newPage();
      const b = await context.newPage();
      const errors: string[] = [];
      for (const page of [a, b]) page.on('pageerror', (error) => errors.push(error.message));
      await a.goto(new URL('publication-recovery-test', origin).href);
      await b.goto(new URL('publication-recovery-test', origin).href);
      const path = '/src/islands/admin/catalog-publication-journal.ts';
      const scope = { productId: 'p', operationId: '12345678-1234-4234-8234-123456789012' };
      const owner = { actorId: 'admin', endpoint: new URL('api/admin', origin).href };
      const first = await a.evaluate(
        async ({ path, owner, scope }) => {
          const module: typeof import('./catalog-publication-journal.ts') = await import(path);
          return module.createPublicationJournal(owner).retain({ scope });
        },
        { path, owner, scope },
      );
      assert.equal(first.durability, 'persistent');
      await a.evaluate(async () => {
        const path = '/src/lib/session.ts';
        const session: typeof import('../../lib/session.ts') = await import(path);
        const observed = { calls: 0, tokenSeen: false };
        Reflect.set(globalThis, '__publicationAuthObserver', observed);
        session.onAuthChange(() => {
          observed.calls++;
        });
        window.addEventListener('storage', (event) => {
          if (event.key === 'channel.token') observed.tokenSeen = true;
        });
      });
      await b.evaluate(
        async ({ path, owner, scope }) => {
          const module: typeof import('./catalog-publication-journal.ts') = await import(path);
          const journal = module.createPublicationJournal(owner);
          journal.retain({ scope: { ...scope, productId: 'q' } });
          journal.retain({
            scope: { ...scope, operationId: '22345678-1234-4234-8234-123456789012' },
          });
        },
        { path, owner, scope },
      );
      await b.evaluate(() => localStorage.setItem('channel.token', 'journal-browser-auth-test'));
      await a.waitForFunction(
        () => Reflect.get(globalThis, '__publicationAuthObserver')?.tokenSeen === true,
      );
      assert.equal(
        await a.evaluate(() => Reflect.get(globalThis, '__publicationAuthObserver')?.calls),
        1,
        'Only the token sentinel may notify auth; earlier recovery writes must be ignored',
      );
      await a.reload();
      const restored = await a.evaluate(
        async ({ path, owner, scope }) => {
          const module: typeof import('./catalog-publication-journal.ts') = await import(path);
          const journal = module.createPublicationJournal(owner);
          const read = journal.read();
          const foreign = module.createPublicationJournal({ ...owner, actorId: 'other' });
          const empty = foreign.read();
          foreign.retain({ scope });
          const afterForget = journal.forget(scope);
          return { read, empty, afterForget, foreign: foreign.read() };
        },
        { path, owner, scope },
      );
      assert.equal(restored.read.durability, 'persistent');
      assert.equal(restored.read.entries.length, 3);
      assert.equal(restored.empty.entries.length, 0);
      assert.equal(restored.afterForget.entries.length, 2);
      assert.deepEqual(restored.foreign.entries, [{ scope }]);
      const blocked = await a.evaluate(
        async ({ path, owner, scope }) => {
          const module: typeof import('./catalog-publication-journal.ts') = await import(path);
          const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
          Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get() {
              throw new DOMException('Storage denied', 'SecurityError');
            },
          });
          try {
            const journal = module.createPublicationJournal(owner);
            const value = journal.retain({ scope });
            return { value, exported: JSON.parse(journal.export(scope)) };
          } finally {
            if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
            else Reflect.deleteProperty(globalThis, 'localStorage');
          }
        },
        { path, owner, scope },
      );
      assert.equal(blocked.value.durability, 'memory');
      assert.ok(blocked.value.problems.includes('unavailable'));
      assert.deepEqual(blocked.exported.entries, [{ scope }]);
      const quota = await a.evaluate(
        async ({ path, owner, scope }) => {
          const module: typeof import('./catalog-publication-journal.ts') = await import(path);
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = () => {
            throw new DOMException('Storage full', 'QuotaExceededError');
          };
          const failedScope = { ...scope, productId: 'quota-original' };
          try {
            const journal = module.createPublicationJournal(owner);
            const value = journal.retain({ scope: failedScope });
            return { value, exported: JSON.parse(journal.export(failedScope)) };
          } finally {
            Storage.prototype.setItem = original;
          }
        },
        { path, owner, scope },
      );
      assert.equal(quota.value.durability, 'memory');
      assert.deepEqual(quota.exported.entries, [
        { scope: { ...scope, productId: 'quota-original' } },
      ]);
      const persistentAgain = await b.evaluate(
        async ({ path, owner, bytes }) => {
          const module: typeof import('./catalog-publication-journal.ts') = await import(path);
          return module.createPublicationJournal(owner).import(bytes);
        },
        { path, owner, bytes: JSON.stringify(quota.exported) },
      );
      assert.equal(persistentAgain.durability, 'persistent');
      assert.ok(
        persistentAgain.entries.some(
          (entry) =>
            entry.scope.productId === 'quota-original' &&
            entry.scope.operationId === scope.operationId,
        ),
      );
      assert.deepEqual(errors, []);
    },
  );
