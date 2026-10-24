import { createRequire } from 'node:module';
import { fetchFully } from '../smoke-http.mjs';
import { assertHostingPath } from './input.mjs';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@cloudbase/manager-node'));
const COS = sdkRequire('cos-nodejs-sdk-v5');

/** Read the authenticated hosting bucket; signed URLs never leave this adapter. */
export async function createHostingObjectReader({ manager, target, request = fetchFully }) {
  const environment = manager.currentEnvironment();
  const bound = () => {
    if (
      !target.envId ||
      manager.cloudBaseConfig.envId !== target.envId ||
      environment.getEnvId() !== target.envId
    )
      throw Error('Backup origin environment differs');
  };
  bound();
  await environment.lazyInit();
  bound();
  const stores = await environment.getHostingService().getInfo();
  if (!Array.isArray(stores) || stores.length !== 1 || stores[0].Status !== 'online')
    throw Error('Hosting origin is unavailable');
  const store = stores[0];
  const external = store.ExternalStorage?.Enabled === true ? store.ExternalStorage : undefined;
  const bucket = store.Bucket || external?.BucketName;
  const region = store.Regoin || external?.Region;
  const basePath = external?.BasePath || '';
  if (typeof basePath !== 'string') throw Error('Invalid hosting origin prefix');
  if (basePath.replace(/^\/+|\/+$/g, '')) assertHostingPath(basePath.replace(/^\/+|\/+$/g, ''));
  if (!/^[a-z0-9-]+$/.test(bucket ?? '') || !/^[a-z]{2}-[a-z0-9-]+$/.test(region ?? ''))
    throw Error('Invalid hosting origin metadata');
  const origins = new Set(
    ['myqcloud.com', 'tencentcos.cn'].map((domain) => `https://${bucket}.cos.${region}.${domain}`),
  );
  const config = manager.cloudBaseConfig;
  if (!config.secretId || !config.secretKey) throw Error('Explicit backup credentials required');
  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    SecurityToken: config.token,
    Domain: '{Bucket}.cos.{Region}.tencentcos.cn',
    Protocol: 'https:',
  });
  return async (method, address, options) => {
    bound();
    if (method !== 'GET') throw Error('Backup origin is read-only');
    const path = assertHostingPath(
      new URL(address).pathname.slice(1).split('/').map(decodeURIComponent).join('/'),
    );
    const key = basePath ? `${basePath.replace(/^\/+|\/+$/g, '')}/${path}` : path;
    try {
      const signed = await new Promise((resolve, reject) =>
        cos.getObjectUrl(
          {
            Bucket: bucket,
            Region: region,
            Key: key,
            Method: 'GET',
            Sign: true,
            Expires: 300,
            Protocol: 'https:',
          },
          (error, data) => (error ? reject(error) : resolve(data?.Url)),
        ),
      );
      const url = new URL(signed);
      if (
        !origins.has(url.origin) ||
        decodeURIComponent(url.pathname.slice(1)) !== key ||
        !url.search
      )
        throw Error('Invalid hosting origin URL');
      return await request('GET', url.href, { ...options, redirect: 'error' });
    } catch (error) {
      // HTTP error messages may contain the signed query. Do not retain them as causes.
      const code = /timed out/.test(error.message)
        ? 'ETIMEDOUT'
        : /^[A-Z0-9_]+$/.test(error.cause?.code ?? error.code ?? '')
          ? (error.cause?.code ?? error.code)
          : 'REQUEST_FAILED';
      throw Object.assign(new Error(`Hosting origin read failed (${code}): ${path}`), { code });
    }
  };
}
