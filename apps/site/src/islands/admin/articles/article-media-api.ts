import {
  ArticleImageFileSchema,
  ArticleMediaViewSchema,
  articleIdentity,
} from '@vibelingan-channel/articles/media';
import { z } from 'zod';
import { AdminApiError, call, putImageUpload } from '../api.ts';

const uploadSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('active'), media: ArticleMediaViewSchema }).strict(),
  z
    .object({
      status: z.literal('pending'),
      mediaId: articleIdentity,
      articleId: articleIdentity,
      expiresAt: z.string().datetime(),
      upload: z
        .object({
          method: z.literal('PUT'),
          url: z
            .string()
            .url()
            .refine((value) => {
              const url = new URL(value);
              return (
                !url.username &&
                !url.password &&
                (url.protocol === 'https:' ||
                  (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
              );
            }),
          headers: z
            .object({
              Signature: z.string().min(1),
              'x-cos-security-token': z.string().min(1),
              'x-cos-meta-fileid': z.string().min(1),
              authorization: z.string().min(1),
              key: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
]);
export async function uploadArticleImage({
  articleId,
  file,
  requestId,
  signal,
}: { articleId: string; file: File; requestId: string; signal: AbortSignal }) {
  const checksum = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const metadata = ArticleImageFileSchema.parse({
    fileName: file.name,
    mimeType: file.type,
    byteSize: file.size,
    checksumSha256: checksum,
  });
  const intent = readMediaResponse(
    uploadSchema,
    await call(
      'articleMedia',
      { operation: 'intent', articleId, requestId, file: metadata },
      signal,
    ),
  );
  if (intent.status === 'active') {
    if (intent.media.articleId !== articleId)
      throw new AdminApiError('INVALID_RESPONSE', 'Image ownership could not be confirmed.');
    return intent.media;
  }
  if (intent.articleId !== articleId)
    throw new AdminApiError('INVALID_RESPONSE', 'Image ownership could not be confirmed.');
  await putImageUpload(file, intent, signal);
  const media = readMediaResponse(
    ArticleMediaViewSchema,
    await call(
      'articleMedia',
      { operation: 'complete', articleId, mediaId: intent.mediaId },
      signal,
    ),
  );
  if (media.articleId !== articleId || media.mediaId !== intent.mediaId)
    throw new AdminApiError('INVALID_RESPONSE', 'The completed image could not be confirmed.');
  return media;
}
export async function getArticleImage(articleId: string, mediaId: string, signal: AbortSignal) {
  const responseSchema = ArticleMediaViewSchema.extend({
    dataBase64: z
      .string()
      .max(4 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }).strict();
  const result = readMediaResponse(
    responseSchema,
    await call('articleMedia', { operation: 'preview', articleId, mediaId }, signal),
  );
  if (result.articleId !== articleId || result.mediaId !== mediaId)
    throw new AdminApiError('INVALID_RESPONSE', 'The preview image could not be confirmed.');
  const bytes = Uint8Array.from(atob(result.dataBase64), (char) => char.charCodeAt(0));
  if (bytes.length !== result.byteSize)
    throw new AdminApiError('INVALID_RESPONSE', 'The preview image bytes were incomplete.');
  return { ...result, dataBase64: undefined, blob: new Blob([bytes], { type: result.mimeType }) };
}

function readMediaResponse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'The image response could not be confirmed. Retry the same file.',
    );
  return result.data;
}
