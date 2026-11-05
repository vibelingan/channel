import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { hostingConfigurationIdentity, inventoryIdentity } from '../hosting-recovery.mjs';
import { errorDocumentPath, validateConfigurationChange } from './hosting-configuration.mjs';
import { createHostingObjectReader } from './hosting-object-reader.mjs';
import {
  articleMediaFile,
  assertHostingPath,
  assertOrigin,
  freeze,
  isSitemap,
  limits,
} from './input.mjs';

/** Capture one Manager environment, independent of MCP's globally selected environment. */
export function createCloudbaseHostingProvider({ manager, target }) {
  const fixed = freeze(structuredClone(target));
  assertOrigin(fixed.site);
  const environment = manager.currentEnvironment();
  if (
    !fixed.envId ||
    manager.getManagerConfig().envId !== fixed.envId ||
    environment.getEnvId() !== fixed.envId
  )
    throw new Error('Hosting manager environment mismatch');
  const hosting = environment.getHostingService();
  const env = environment.getEnvService();
  const bound = () => {
    if (environment.getEnvId() !== fixed.envId || manager.getManagerConfig().envId !== fixed.envId)
      throw new Error('Hosting manager environment changed');
  };
  const safe = async (callback) => {
    bound();
    try {
      await environment.lazyInit();
      if (environment.lazyEnvironmentConfig?.EnvId !== fixed.envId)
        throw new Error('Foreign environment metadata');
      bound();
      return await callback();
    } catch {
      throw new Error(
        'CloudBase hosting operation unconfirmed; inspect its journal before retrying',
      );
    }
  };
  const readConfiguration = () =>
    safe(async () => {
      const stores = await hosting.getInfo();
      if (!Array.isArray(stores) || stores.length !== 1 || stores[0].Status !== 'online')
        throw new Error('Hosting store unavailable');
      const website = await hosting.getWebsiteConfig();
      if (website.statusCode !== 200) throw new Error('Website read failed');
      const gateway = await env.describeHttpServiceRoute({
        EnvId: fixed.envId,
        Filters: [{ Name: 'Domain', Values: [new URL(fixed.site).hostname] }],
        Offset: 0,
        Limit: 100,
      });
      if (
        gateway.TotalCount !== 1 ||
        gateway.Domains?.length !== 1 ||
        gateway.Domains[0].Domain !== new URL(fixed.site).hostname ||
        !gateway.RequestId
      )
        throw new Error('Domain binding is unproven');
      return structuredClone(
        hostingConfigurationIdentity({
          website: { ...website, Bucket: stores[0].Bucket, CdnDomain: stores[0].CdnDomain },
          gateway,
        }),
      );
    });
  /** Every member needs its own file completion; SDK counts alone never confirm an object. */
  async function uploadFiles(input, parallel, signal) {
    const files = input.map(({ path, body: bytes }) => {
      assertHostingPath(path);
      if (path === '404.html') throw new Error('Reserved CloudBase fallback path');
      if (/^(?:__auth\/|\.cloudbase-backup\/|google[a-z0-9]+\.html$|BingSiteAuth\.xml$)/.test(path))
        throw new Error('Protected hosting path');
      const body = Buffer.from(bytes);
      if (body.length > limits.fileBytes) throw new Error('Hosting object size limit');
      return { path, body };
    });
    if (new Set(files.map((file) => file.path)).size !== files.length)
      throw new Error('Duplicate hosting upload path');
    signal?.throwIfAborted();
    const directory = mkdtempSync(join(tmpdir(), 'seo-hosting-upload-'));
    const completed = new Map();
    try {
      // A directory per member keeps same-named files apart and their extension for COS MIME.
      const staged = files.map((file, index) => {
        mkdirSync(join(directory, String(index)));
        const localPath = join(directory, String(index), basename(file.path));
        writeFileSync(localPath, file.body, { mode: 0o400 });
        return { localPath, cloudPath: file.path };
      });
      return await safe(async () => {
        const result = await hosting.uploadFiles({
          files: staged,
          parallel,
          retryCount: 0,
          safe: false,
          prune: false,
          verify: false,
          onFileFinish: (error, result, file) => {
            if (
              !error &&
              files.some((member) => member.path === file?.cloudFileKey) &&
              (result?.statusCode === 200 || (result && Object.keys(result).length === 0))
            )
              completed.set(file.cloudFileKey, result.headers?.['x-cos-request-id']);
          },
        });
        if (
          completed.size !== files.length ||
          result?.successCount !== files.length ||
          result?.totalFiles !== files.length ||
          !Array.isArray(result.failedFiles) ||
          result.failedFiles.length
        )
          throw new Error('Unconfirmed upload result');
        return files.map(({ path }) => {
          const providerOperationId = completed.get(path);
          return { path, ...(providerOperationId ? { providerOperationId } : {}) };
        });
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  let backupReader;
  return Object.freeze({
    target: fixed,
    async readBackupObject(method, address, options) {
      backupReader ??= createHostingObjectReader({ manager, target: fixed });
      return (await backupReader)(method, address, options);
    },
    readConfiguration,
    async readInventory() {
      return safe(async () => {
        const entries = [];
        const markers = new Set();
        let marker;
        for (;;) {
          const page = await hosting.findFiles({
            prefix: '',
            maxKeys: 1000,
            ...(marker ? { marker } : {}),
          });
          if (
            !Array.isArray(page.Contents) ||
            ![true, false, 'true', 'false'].includes(page.IsTruncated)
          )
            throw new Error('Incomplete hosting inventory');
          entries.push(
            ...page.Contents.map((item) => ({
              path: item.Key,
              bytes: Number(item.Size),
              etag: item.ETag,
              lastModified: item.LastModified,
            })),
          );
          if (entries.length > limits.files) throw new Error('Hosting inventory count limit');
          if ([false, 'false'].includes(page.IsTruncated)) break;
          marker = page.NextMarker;
          if (!marker || markers.has(marker)) throw new Error('Incomplete hosting pagination');
          markers.add(marker);
        }
        inventoryIdentity(entries);
        return entries.filter((entry) => !entry.path.endsWith('/'));
      });
    },
    async upload(path, input, { signal } = {}) {
      const [file] = await uploadFiles([{ path, body: input }], 1, signal);
      return {
        terminal: true,
        ...(file.providerOperationId ? { providerOperationId: file.providerOperationId } : {}),
      };
    },
    /** One SDK call per journaled batch: one bucket lookup and one COS client for all members. */
    async uploadBatch(files, { signal, parallel } = {}) {
      if (!Array.isArray(files) || !files.length || files.length > 12)
        throw new Error('Invalid hosting upload batch size');
      if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > files.length)
        throw new Error('Invalid hosting upload parallel limit');
      return { terminal: true, files: await uploadFiles(files, parallel, signal) };
    },
    async remove(path, { signal } = {}) {
      assertHostingPath(path);
      if (
        ['index.html', '404.html', errorDocumentPath].includes(path) ||
        /^(?:__auth\/|\.cloudbase-backup\/|google[a-z0-9]+\.html$|BingSiteAuth\.xml$)/.test(path) ||
        !(
          path.endsWith('.html') ||
          articleMediaFile.test(path) ||
          isSitemap(path) ||
          ['robots.txt', 'seo-manifest.json', 'products/manifest.json'].includes(path)
        )
      )
        throw new Error('Hosting deletion not allowed');
      signal?.throwIfAborted();
      return safe(async () => {
        const result = await hosting.deleteFiles({ cloudPath: path, isDir: false });
        if (
          !Array.isArray(result?.Error) ||
          result.Error.length ||
          result.Deleted?.length !== 1 ||
          result.Deleted[0].Key !== path
        )
          throw new Error('Unconfirmed exact delete');
        return { terminal: true };
      });
    },
    async configure(input, { signal } = {}) {
      const change = structuredClone(input);
      const current = await readConfiguration();
      const args = validateConfigurationChange({ change, current, target: fixed });
      signal?.throwIfAborted();
      return safe(async () => {
        const result =
          change.kind === 'website'
            ? await hosting.setWebsiteDocument(args)
            : await env.modifyHttpServiceRoute(args);
        const providerOperationId = result?.RequestId ?? result?.headers?.['x-cos-request-id'];
        if (change.kind === 'website' ? result?.statusCode !== 200 : !providerOperationId)
          throw new Error('Unconfirmed configuration response');
        return { terminal: true, ...(providerOperationId ? { providerOperationId } : {}) };
      });
    },
    purgeCapability: Object.freeze({
      status: 'unverified',
      reason: 'No cache-purge contract or browser-cache invalidation is enabled by this port',
    }),
  });
}
