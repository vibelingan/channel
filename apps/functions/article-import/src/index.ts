import cloudbase from '@cloudbase/node-sdk';
import { createArticleImportService } from '@vibelingan-channel/articles/import-store';
import { articleTransaction } from '@vibelingan-channel/db/article-repository';
import { handleArticleImportEvent } from './http-adapter.ts';
const envId = process.env.TCB_ENV;
if (process.env.ARTICLE_IMPORT_ENABLED === '1' && envId !== 'diversity-123-d9grnqfux221323bb')
  throw Error('Article import requires its explicit environment.');
const service =
  process.env.ARTICLE_IMPORT_ENABLED === '1'
    ? createArticleImportService(
        articleTransaction(cloudbase.init({ env: 'diversity-123-d9grnqfux221323bb' }).database()),
      )
    : undefined;
export const main = (event: unknown) =>
  handleArticleImportEvent(event, service, process.env.CHANNEL_BUILD_SHA || 'local');
