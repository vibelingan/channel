import cloudbase from '@cloudbase/node-sdk';
import { createArticleImageService } from '@vibelingan-channel/articles/import-media';
import { createArticleImportService } from '@vibelingan-channel/articles/import-store';
import { articleTransaction } from '@vibelingan-channel/db/article-repository';
import { createCloudBaseMediaStorage } from '@vibelingan-channel/media-storage/cloudbase';
import { handleArticleImportEvent } from './http-adapter.ts';
import { createArticleImageStorage } from './image-storage.ts';
const envId = process.env.TCB_ENV;
if (process.env.ARTICLE_IMPORT_ENABLED === '1' && envId !== 'diversity-123-d9grnqfux221323bb')
  throw Error('Article import requires its explicit environment.');
const app =
  process.env.ARTICLE_IMPORT_ENABLED === '1'
    ? cloudbase.init({ env: 'diversity-123-d9grnqfux221323bb' })
    : undefined;
const transaction = app ? articleTransaction(app.database()) : undefined;
const service =
  process.env.ARTICLE_IMPORT_ENABLED === '1' && app && transaction
    ? {
        ...createArticleImportService(transaction),
        images: createArticleImageService(
          transaction,
          createArticleImageStorage(createCloudBaseMediaStorage(app)),
        ),
      }
    : undefined;
export const main = (event: unknown) =>
  handleArticleImportEvent(event, service, process.env.CHANNEL_BUILD_SHA || 'local');
