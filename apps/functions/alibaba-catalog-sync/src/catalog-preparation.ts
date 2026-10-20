import type { CatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-jobs';
import { runCatalogPreparationWorker } from '@vibelingan-channel/fn-admin/catalog-preparation-worker';
import { importCandidateImage } from './media-import.ts';

/** Only CloudBase platform metadata is removed; unknown business fields remain signature-rejected. */
export function catalogPreparationCallInput(event: unknown): unknown {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const call = { ...event };
  Reflect.deleteProperty(call, 'tcbContext');
  Reflect.deleteProperty(call, 'userInfo');
  return call;
}

/** The same source-capable execution is used by the deployed entrypoint and local server. */
export function runCatalogPreparationCall(authority: CatalogPreparationAuthority, call: unknown) {
  return runCatalogPreparationWorker(authority, catalogPreparationCallInput(call), {
    importSourceImage: (sourceUrl, persistImport) =>
      importCandidateImage(sourceUrl, { persistImport }),
  });
}
