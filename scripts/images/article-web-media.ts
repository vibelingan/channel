import { createHash } from 'node:crypto';
import {
  type ArticleWebMediaReady,
  ArticleWebMediaReadySchema,
  articleWebMediaObjectInput,
  articleWebMediaSource,
  articleWebMediaSourceDigest,
  assertArticleWebMediaSource,
} from '../../packages/articles/src/web-media.ts';
import {
  type MediaStorageAdapter,
  type StoredMediaObject,
  objectStoragePath,
} from '../../packages/media-storage/src/index.ts';
import { decodeCatalogImagePixels } from '../../packages/media-storage/src/pixels.ts';
import { createCatalogWebImage } from '../../packages/media-storage/src/web-image.ts';

interface PrepareInput {
  active: unknown;
  existing?: unknown;
  storage: Pick<MediaStorageAdapter, 'getObjectAsBase64' | 'putObject'>;
  checkpoint(target: Readonly<StoredMediaObject>): Promise<void>;
  register(entry: ArticleWebMediaReady): Promise<'registered' | 'unchanged'>;
}

/** Prepare only explicitly selected media. Publishing and original records are outside this function. */
export async function prepareArticleWebMedia(input: PrepareInput) {
  const source = articleWebMediaSource(input.active);
  if (input.existing !== undefined && input.existing !== null) {
    const entry = assertArticleWebMediaSource(input.existing, input.active);
    return { status: await input.register(entry), entry, byteReads: 0, objectWrites: 0 };
  }
  if (typeof input.checkpoint !== 'function') throw Error('Durable image checkpoint required');
  const original = await input.storage.getObjectAsBase64(source.storageFileId, {
    maxBytes: source.byteSize,
    timeoutMs: 15_000,
  });
  const bytes = verifiedBytes(original.body, source.byteSize, source.checksumSha256, 'source');
  await verifyPixels(bytes, source.mimeType, source.width, source.height, 'source');
  const generated = await createCatalogWebImage(bytes, source.mimeType);
  if (generated.sourceSha256 !== source.checksumSha256)
    throw Error('Prepared article source differs');
  const object = articleWebMediaObjectInput(source, generated.checksumSha256);
  const expectedPath = objectStoragePath(object);
  const entryFor = (target: StoredMediaObject) => {
    if (target.storagePath !== expectedPath) throw Error('Prepared article object path differs');
    return ArticleWebMediaReadySchema.parse({
      status: 'ready',
      policyVersion: 'article-web-v1',
      source,
      sourceDigest: articleWebMediaSourceDigest(source),
      web: {
        storageProvider: target.storageProvider,
        storageFileId: target.storageFileId,
        storagePath: target.storagePath,
        mimeType: generated.mimeType,
        byteSize: generated.byteSize,
        width: generated.width,
        height: generated.height,
        checksumSha256: generated.checksumSha256,
      },
    });
  };
  let checkpointed: ArticleWebMediaReady | undefined;
  const target = await input.storage.putObject(
    { ...object, mimeType: generated.mimeType, content: generated.bytes },
    {
      beforeWrite: async (target) => {
        if (checkpointed) throw Error('Only one article object may be written');
        const entry = entryFor(target);
        await input.checkpoint(Object.freeze({ ...target }));
        checkpointed = entry;
      },
    },
  );
  const entry = entryFor(target);
  if (!checkpointed || JSON.stringify(entry) !== JSON.stringify(checkpointed))
    throw Error('Article upload target was not durably recorded');
  const readback = await input.storage.getObjectAsBase64(entry.web.storageFileId, {
    maxBytes: entry.web.byteSize,
    timeoutMs: 15_000,
  });
  const downloaded = verifiedBytes(
    readback.body,
    entry.web.byteSize,
    entry.web.checksumSha256,
    'readback',
  );
  await verifyPixels(downloaded, entry.web.mimeType, entry.web.width, entry.web.height, 'readback');
  return { status: await input.register(entry), entry, byteReads: 2, objectWrites: 1 };
}

function verifiedBytes(body: string, size: number, sha256: string, stage: string) {
  const bytes = Buffer.from(body, 'base64');
  if (
    bytes.toString('base64') !== body ||
    bytes.length !== size ||
    createHash('sha256').update(bytes).digest('hex') !== sha256
  )
    throw Error(`Article image ${stage} bytes differ`);
  return bytes;
}

async function verifyPixels(
  bytes: Uint8Array,
  mimeType: string,
  width: number,
  height: number,
  stage: string,
) {
  const pixels = await decodeCatalogImagePixels(bytes, mimeType);
  if (
    pixels.status !== 'decoded' ||
    pixels.pages !== 1 ||
    pixels.width !== width ||
    pixels.height !== height
  )
    throw Error(`Article image ${stage} pixels differ`);
}
