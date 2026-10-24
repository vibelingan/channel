import {
  type CatalogImagePixels,
  decodeCatalogImagePixels,
} from '@vibelingan-channel/media-storage/pixels';
import {
  type StoredCatalogImageByteCheck,
  type StoredImageReadOptions,
  inspectStoredCatalogImage,
} from './catalog-image-bytes.ts';

type ByteFailure = Extract<StoredCatalogImageByteCheck, { status: 'invalid' | 'retry' }>;
type ByteProof = Extract<StoredCatalogImageByteCheck, { status: 'verified' }>;
export type StoredCatalogImageHealth =
  | (Omit<ByteProof, 'kind'> & {
      kind: 'stored-image-health-v1';
      width: number;
      height: number;
      pages: number;
    })
  | ByteFailure
  | Extract<CatalogImagePixels, { status: 'retry' }>;

/** Read-only current-storage evidence. It is not a preparation seal or publish permission. */
export function readStoredCatalogImageHealth(
  imageId: string,
  options: StoredImageReadOptions & {
    decodePixels?: (bytes: Uint8Array, mimeType: string) => Promise<CatalogImagePixels>;
  } = {},
): Promise<StoredCatalogImageHealth> {
  const decodePixels = options.decodePixels ?? decodeCatalogImagePixels;
  return inspectStoredCatalogImage(
    imageId,
    async (proof, bytes, mimeType): Promise<StoredCatalogImageHealth> => {
      const pixels = await decodePixels(bytes, mimeType);
      if (pixels.status !== 'decoded')
        return pixels.status === 'invalid'
          ? { status: 'invalid', reason: pixels.reason }
          : { status: 'retry', reason: pixels.reason };
      if (pixels.checksumSha256 !== proof.checksumSha256)
        return { status: 'invalid', reason: 'checksum' };
      return {
        status: 'verified',
        kind: 'stored-image-health-v1',
        imageId: proof.imageId,
        inputDigest: proof.inputDigest,
        byteSize: proof.byteSize,
        checksumSha256: proof.checksumSha256,
        width: pixels.width,
        height: pixels.height,
        pages: pixels.pages,
      };
    },
    options,
  );
}
