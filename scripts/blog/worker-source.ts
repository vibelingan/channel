import { createRequire } from 'node:module';
const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url));
export function blogWorkerSdk(config: Record<string, string>) {
  return dbRequire('@cloudbase/node-sdk').init(config);
}
