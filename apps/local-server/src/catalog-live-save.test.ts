import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLiveSaveStorageContract } from '../../../packages/db/src/catalog-live-save-contract.fixture.ts';
import { JsonFileAdapter } from './json-adapter.ts';
registerLiveSaveStorageContract('JSON', (t, initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-live-save-'));
  const file = join(dir, 'db.json');
  writeFileSync(file, JSON.stringify(initial));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let adapter = new JsonFileAdapter(file);
  return {
    persist: (actor, command) => adapter.persistCatalogDetailApproval(actor, command),
    save: (input) => adapter.saveCatalogProductWithIdentities(input),
    get: (collection, id) => adapter.get(collection, id),
    // Privileged storage fault, bypassing the ordinary image mutex/ledger write guard.
    put: async (collection, row) => {
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      stored[collection] ??= [];
      const index = stored[collection].findIndex(
        (candidate: { _id: string }) => candidate._id === row._id,
      );
      if (index < 0) stored[collection].push(row);
      else stored[collection][index] = row;
      writeFileSync(file, JSON.stringify(stored));
      adapter = new JsonFileAdapter(file);
    },
    snapshot: () => readFileSync(file, 'utf8'),
    failProof: () => {
      const backup = join(dir, 'before-failure.json');
      renameSync(file, backup);
      mkdirSync(file);
      return () => {
        rmSync(file, { recursive: true });
        renameSync(backup, file);
      };
    },
  };
});
