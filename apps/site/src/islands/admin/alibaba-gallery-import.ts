import { AlibabaSyncApiError } from './alibaba-catalog-sync/alibaba-api.ts';
import { alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';

interface GalleryImportInput {
  sourceUrls: unknown;
  imageIds: string[];
  importImage: (url: string) => Promise<{ imageId: string; deduplicated: boolean }>;
  onProgress: (ids: string[]) => void;
}

/** Bounded sequential admission through the existing authenticated image importer. */
export async function importAlibabaGallery(input: GalleryImportInput) {
  const urls = [...new Set(alibabaSourcePreviewUrls(input.sourceUrls, 9))];
  const imageIds = [...new Set(input.imageIds)];
  const createdIds: string[] = [];
  const failures: Array<{ position: number; message: string }> = [];
  let attempted = 0;
  for (const [index, url] of urls.entries()) {
    if (imageIds.length >= 9) break;
    attempted += 1;
    try {
      const imported = await input.importImage(url);
      if (
        typeof imported?.imageId !== 'string' ||
        !imported.imageId.trim() ||
        typeof imported.deduplicated !== 'boolean'
      ) {
        throw new Error('Image import result was not confirmed.');
      }
      if (!imported.deduplicated && !createdIds.includes(imported.imageId))
        createdIds.push(imported.imageId);
      if (!imageIds.includes(imported.imageId)) {
        imageIds.push(imported.imageId);
        input.onProgress([...imageIds]);
      }
    } catch (error) {
      failures.push({
        position: index + 1,
        message: error instanceof Error ? error.message : 'Image import failed.',
      });
      // A revoked session or lost response is not a bad individual image.
      // Preserve confirmed results and stop, instead of submitting the rest blindly.
      if (
        !(error instanceof AlibabaSyncApiError) ||
        !['VALIDATION_ERROR', 'BAD_REQUEST', 'NOT_FOUND'].includes(error.code)
      )
        break;
    }
  }
  return { imageIds, createdIds, failures, remaining: urls.length - attempted };
}
