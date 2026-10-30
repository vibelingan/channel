import cloudbase from '@cloudbase/node-sdk';
import { assertDocumentWrite } from '../../packages/db/src/cloudbase-sdk-answer.ts';
import { createCatalogGithubApp } from '../../scripts/release/catalog-github-app.mjs';
import { wakeCatalog } from '../../scripts/release/catalog-wakeup.mjs';
const environment = 'diversity-123-d9grnqfux221323bb';
const site = 'https://supplychainsai.com';
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
  const wakeId = 'supplychainsai-com';
  const row = (result) => {
    if (!result || !Object.hasOwn(result, 'data')) throw Error('Missing clock SDK response');
    return Array.isArray(result.data) ? result.data[0] : result.data;
  };
  const store = {
    async hasPending(origin) {
      if (origin !== site) throw Error('Wrong pending queue target');
      for (const collection of ['catalogSeoRequests', 'catalogSeoTasks']) {
        const result = await db
          .collection(collection)
          .where({ siteOrigin: site, state: 'pending' })
          .limit(1)
          .get();
        if (!Array.isArray(result.data)) throw Error('Missing pending queue');
        if (result.data.length) return true;
      }
      return false;
    },
    async activeRenderer() {
      return row(await db.collection('catalogSeoBuilders').doc('active').get());
    },
    async claim({ now, nonce, holdMs }) {
      return db.runTransaction(async (tx) => {
        const doc = tx.collection('catalogSeoWakeups').doc(wakeId);
        const previous = row(await doc.get());
        if (previous && (!Number.isSafeInteger(previous.until) || previous.until > now))
          return false;
        assertDocumentWrite(
          await doc.set({ owner: nonce, until: now + holdMs, state: 'sending', siteOrigin: site }),
          wakeId,
          'set',
        );
        return true;
      });
    },
    async finish(nonce, result) {
      await db.runTransaction(async (tx) => {
        const doc = tx.collection('catalogSeoWakeups').doc(wakeId);
        const current = row(await doc.get());
        if (current?.owner !== nonce) throw Error('Clock notification owner changed');
        const data = Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_id'));
        assertDocumentWrite(
          await doc.set({
            ...data,
            ...result,
            until: result.checkedAt + (result.state === 'unknown' ? 600000 : 180000),
          }),
          wakeId,
          'set',
        );
      });
    },
  };
  const github = createCatalogGithubApp({
    appId: process.env.CATALOG_GITHUB_APP_ID,
    installationId: process.env.CATALOG_GITHUB_INSTALLATION_ID,
    privateKey: process.env.CATALOG_GITHUB_PRIVATE_KEY,
  });
  const result = await wakeCatalog({ store, github });
  console.log(JSON.stringify(result));
  return result;
}
