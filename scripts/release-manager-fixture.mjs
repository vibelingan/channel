import { readFileSync } from 'node:fs';
import CloudBase from '@cloudbase/manager-node';
import { configuration, target } from './release-hosting-fixtures.mjs';

/** Run installed Manager SDK services; replace only Cloud API and COS transports. */
export function managerFixture({ request, initialConfiguration = configuration() } = {}) {
  const state = {
    configuration: structuredClone(initialConfiguration),
    files: new Map(),
    calls: [],
    fail: null,
    uploads: 0,
    deleted: 0,
    envId: target.envId,
    store: {
      Status: 'online',
      Bucket: 'fixture-bucket',
      Regoin: 'ap-shanghai',
      CdnDomain: 'fixture.example',
    },
  };
  const manager = new CloudBase({
    envId: target.envId,
    requestFn: async ({ action, payload }) => {
      state.calls.push({ action, payload: structuredClone(payload) });
      if (request) {
        const result = await request({ action, payload });
        if (result !== undefined) return result;
      }
      if (action === 'DescribeEnvInfo')
        return {
          EnvInfo: {
            EnvBaseInfo: {
              EnvId: state.envId,
              Storages: [],
              Databases: [{ InstanceId: 'fixture-db' }],
              StaticStorages: [{ DomainType: 'gateway' }],
            },
          },
        };
      if (action === 'DescribeStaticStore') return { Data: [state.store] };
      if (action === 'DescribeHTTPServiceRoute')
        return {
          ...structuredClone(state.configuration.gateway),
          TotalCount: 1,
          RequestId: 'read-routes',
        };
      if (action === 'ModifyHTTPServiceRoute') {
        if (state.fail === 'configure') throw new Error('secret credential must not leak');
        state.onEffect?.();
        const domain = state.configuration.gateway.Domains.find(
          (x) => x.Domain === payload.Domain.Domain,
        );
        domain.UpdateTime = '2026-10-21T00:00:00Z';
        if (payload.Domain.Extension) domain.Extension = structuredClone(payload.Domain.Extension);
        for (const route of payload.Domain.Routes ?? []) {
          const existing = domain.Routes.find((x) => x.Path === route.Path);
          Object.assign(existing, structuredClone(route));
        }
        return state.fail === 'missing-request-id' ? {} : { RequestId: 'modify-routes' };
      }
      throw new Error(`Unexpected SDK action: ${action}`);
    },
  });
  const storage = manager.currentEnvironment().getStorageService();
  storage.getCos = () => ({
    uploadFiles(options, callback) {
      state.uploads++;
      if (state.fail === 'upload') {
        callback(new Error('fixture upload failure'));
        return;
      }
      for (const file of options.files) {
        state.onEffect?.();
        state.lastFilePath = file.FilePath;
        state.calls.push({ action: 'cos-upload', key: file.Key });
        state.files.set(file.Key, readFileSync(file.FilePath));
        if (state.fail !== 'missing-callback')
          options.onFileFinish(
            null,
            { statusCode: 200, headers: { 'x-cos-request-id': 'put-file' } },
            file,
          );
      }
      callback(null, { files: [] });
    },
    deleteObject(options, callback) {
      state.onEffect?.();
      state.deleted++;
      state.calls.push({ action: 'cos-delete', key: options.Key });
      if (state.fail === 'delete') {
        callback(new Error('fixture delete failure'));
        return;
      }
      state.files.delete(options.Key);
      callback(null, { statusCode: 204 });
    },
    getBucketWebsite(_options, callback) {
      callback(null, { statusCode: 200, ...structuredClone(state.configuration.website) });
    },
    putBucketWebsite(options, callback) {
      if (state.fail === 'website') {
        callback(new Error('secret credential must not leak'));
        return;
      }
      state.onEffect?.();
      state.calls.push({
        action: 'cos-website',
        config: structuredClone(options.WebsiteConfiguration),
      });
      state.configuration.website.WebsiteConfiguration = structuredClone(
        options.WebsiteConfiguration,
      );
      callback(null, { statusCode: 200, headers: { 'x-cos-request-id': 'put-website' } });
    },
  });
  return { manager, state };
}
