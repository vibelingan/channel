import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { productSubcategoryWhere } from '../packages/db/src/product-subcategory-query.ts';
import {
  bootstrapProbe,
  cleanupProbe,
  probeFailure,
  runTransactionProbe,
} from './probe-catalog-taxonomy-helpers.mjs';

const cli = (args) =>
  execFileSync('tcb', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });

export async function main() {
  try {
    const envId = process.env.TCB_ENV_ID;
    const database = bootstrapProbe({
      envId,
      allowIsolatedWrites: process.argv.includes('--allow-isolated-writes'),
      cli,
      loadSdk: () =>
        createRequire(new URL('../packages/db/package.json', import.meta.url))(
          '@cloudbase/node-sdk',
        ),
    });
    await runProbe(database, envId);
  } catch (error) {
    console.error(JSON.stringify(probeFailure(error)));
    process.exitCode = 1;
  }
}

async function runProbe(database, envId) {
  const command = database.command;
  const collectionName = `taxonomyProbe${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const collection = database.collection(collectionName);
  async function retryNetwork(operation) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === 2 || !['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED'].includes(error?.code))
          throw error;
        console.log(
          JSON.stringify({ phase: 'network-retry', attempt: attempt + 1, code: error.code }),
        );
      }
    }
  }
  const writtenIds = [];
  let created = false;
  let passed = false;
  try {
    await database.createCollection(collectionName);
    created = true;
    cli([
      'permission',
      'set',
      `collection:${collectionName}`,
      '--level',
      'adminonly',
      '-e',
      envId,
      '--json',
    ]);
    console.log(JSON.stringify({ phase: 'isolated-collection', envId, collectionName }));
    for (const family of ['headphones', 'ai-gadgets', 'toys', 'misc']) {
      const first = family === 'headphones' ? 'headphones-wired' : `${family}-first`;
      const second = family === 'headphones' ? 'headphones-office' : `${family}-second`;
      const knownIds = [first, second, `${family}-archived`];
      const fixtures = Array.from({ length: 25 }, (_, index) => ({
        id: `${family}-valid-${String(index).padStart(2, '0')}`,
        data: {
          productFamily: family,
          subcategoryIds: index % 2 ? [first] : [first, second],
          published: true,
        },
        matches: true,
      }));
      for (const [index, subcategoryIds] of [
        [],
        null,
        first,
        [first, 42],
        [first, first],
        [first, 'unknown'],
      ].entries()) {
        fixtures.push({
          id: `${family}-bad-${index}`,
          data: { productFamily: family, subcategoryIds, published: true },
          matches: false,
        });
      }
      fixtures.push({
        id: `${family}-private`,
        data: { productFamily: family, subcategoryIds: [first], published: false },
        matches: false,
      });
      if (family === 'headphones') {
        fixtures.push({
          id: 'legacy-wired',
          data: { category: 'wired', published: true },
          matches: true,
        });
        fixtures.push({
          id: 'explicit-none',
          data: { category: 'wired', subcategoryIds: [], published: true },
          matches: false,
        });
      }
      for (const fixture of fixtures) {
        writtenIds.push(fixture.id);
        await retryNetwork(() => collection.doc(fixture.id).set(fixture.data));
      }
      const filter = command.and([
        productSubcategoryWhere(command, { family, ids: [first, second], knownIds }),
        { published: command.eq(true) },
      ]);
      const base = collection.where(filter);
      const expected = fixtures
        .filter((fixture) => fixture.matches)
        .map((fixture) => fixture.id)
        .sort();
      const total = (await retryNetwork(() => base.count())).total;
      assert.equal(total, expected.length, `${family}: count`);
      const actual = [];
      for (let offset = 0; offset < total; offset += 12) {
        const result = await retryNetwork(() =>
          base.orderBy('_id', 'asc').skip(offset).limit(12).get(),
        );
        assert.ok(result.data.length <= 12);
        actual.push(...result.data.map((row) => row._id));
      }
      assert.deepEqual(actual, expected, `${family}: complete unique pages`);
      console.log(
        JSON.stringify({ phase: 'query-pass', family, total, pages: Math.ceil(total / 12) }),
      );
    }
    const registryId = 'concurrent-registry';
    writtenIds.push(registryId);
    await collection.doc(registryId).set({ revision: 0 });
    await runTransactionProbe({ database, collectionName, registryId });
    console.log(JSON.stringify({ phase: 'transaction-pass', outcomes: ['conflict', 'saved'] }));
    passed = true;
  } catch (error) {
    console.error(JSON.stringify(probeFailure(error)));
    process.exitCode = 1;
  } finally {
    if (created) {
      await cleanupProbe({
        collection,
        collectionName,
        writtenIds,
        retry: retryNetwork,
        log: (record) => console.log(JSON.stringify(record)),
      });
    }
  }
  if (passed && !process.exitCode) {
    console.log(JSON.stringify({ phase: 'complete', status: 'CATALOG_TAXONOMY_CLOUD_PROBE_PASS' }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
