const factoryVideoSha256 = '3cd89b386c1d4abff155e36a47b57c418916d90a289e95d0a5b3873faf3a1e8d';

/** Exactly one already-public asset is delivered by the range-capable Blog static server. */
export const factoryVideoAsset = {
  source: '/media/oem-factory.mp4',
  sha256: factoryVideoSha256,
  bytes: 7201197,
  clientPath: `media/factory/oem-factory.${factoryVideoSha256.slice(0, 12)}.mp4`,
} as const;

export const factoryVideoRangePath = `/blog/${factoryVideoAsset.clientPath}`;
