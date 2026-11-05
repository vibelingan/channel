import cloudbase from '@cloudbase/node-sdk';
import { createCatalogGithubApp } from '../../scripts/release/catalog-github-app.mjs';
import { wakeCatalog } from '../../scripts/release/catalog-wakeup.mjs';
import { createCatalogClockStore } from './store.mjs';
const environment = 'diversity-123-d9grnqfux221323bb';
export async function main(event) {
  if (process.env.TCB_ENV !== environment) throw Error('Wrong catalog clock target');
  if (event?.action === 'health')
    return {
      service: 'catalog-seo-clock',
      codeSha: __CLOCK_SHA__,
      enabled: process.env.CATALOG_SEO_CLOCK_ENABLED === '1',
    };
  if (process.env.CATALOG_SEO_CLOCK_ENABLED !== '1') return { status: 'disabled' };
  if (event?.Type !== 'Timer' || event?.TriggerName !== 'catalog-seo-minute')
    throw Error('Only the private timer can wake catalog delivery');
  const db = cloudbase.init({ env: environment }).database();
  const store = createCatalogClockStore(db);
  const github = createCatalogGithubApp({
    appId: process.env.CATALOG_GITHUB_APP_ID,
    installationId: process.env.CATALOG_GITHUB_INSTALLATION_ID,
    privateKey: process.env.CATALOG_GITHUB_PRIVATE_KEY,
  });
  const result = store.outcome(await wakeCatalog({ store, github }));
  console.log(JSON.stringify(result));
  return result;
}
