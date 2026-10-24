import type { MediaStorageAdapter } from '@vibelingan-channel/media-storage';
import {
  type CloudBaseStorageSdk,
  createCloudBaseMediaStorage,
} from '@vibelingan-channel/media-storage/cloudbase';
export const BLOG_DUMMY_STORAGE_PREFIX = '__blog-dummy/';
export function assertBlogDummyFileId(id: string, envId: string) {
  const url = new URL(id);
  if (
    url.protocol !== 'cloud:' ||
    !url.hostname.startsWith(`${envId}.`) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(`/${BLOG_DUMMY_STORAGE_PREFIX}articles/`) ||
    /[%\\]/.test(url.pathname) ||
    url.pathname.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error('Storage identity is outside the isolated Blog scope');
}
export function createBlogDummyStorage(
  sdk: CloudBaseStorageSdk,
  envId: string,
): MediaStorageAdapter {
  const path = (value: string) => {
    if (!/^articles\/[0-9]{4}\/[0-9]{2}\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(value))
      throw new Error('Storage path is outside the isolated Blog scope');
    return BLOG_DUMMY_STORAGE_PREFIX + value;
  };
  const adapter = createCloudBaseMediaStorage({
    ...sdk,
    uploadFile: async (input) => sdk.uploadFile({ ...input, cloudPath: path(input.cloudPath) }),
    getUploadMetadata: async (input) => sdk.getUploadMetadata({ cloudPath: path(input.cloudPath) }),
    downloadFile: async (input) => {
      assertBlogDummyFileId(input.fileID, envId);
      return sdk.downloadFile(input);
    },
    getTempFileURL: async () => {
      throw new Error('Dummy private images use authenticated byte previews only');
    },
    deleteFile: async () => {
      throw new Error('Dummy cleanup requires a separately reviewed exact object list');
    },
  });
  return {
    ...adapter,
    putObject: async (input) => {
      const value = await adapter.putObject(input);
      assertBlogDummyFileId(value.storageFileId, envId);
      return { ...value, storagePath: BLOG_DUMMY_STORAGE_PREFIX + value.storagePath };
    },
    getUploadCredential: async (value) => {
      const result = await adapter.getUploadCredential(value);
      assertBlogDummyFileId(result.storageFileId, envId);
      return result;
    },
  };
}
