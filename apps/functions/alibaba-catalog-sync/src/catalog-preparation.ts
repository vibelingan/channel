import type { CatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-jobs';
import { runCatalogPreparationWorker } from '@vibelingan-channel/fn-admin/catalog-preparation-worker';
import { importCandidateImage } from './media-import.ts';

/** The same source-capable execution is used by the deployed entrypoint and local server. */
export function runCatalogPreparationCall(authority: CatalogPreparationAuthority, call: unknown) {
  return runCatalogPreparationWorker(authority, call, {
    importSourceImage: (sourceUrl, persistImport) =>
      importCandidateImage(sourceUrl, { persistImport }),
  });
}
