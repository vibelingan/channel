export { catalogProtectedStoragePath } from '@vibelingan-channel/shared/catalog-media-protection';

/** Dedicated browser-upload broker only. Internal tracked server PUTs use their private minter. */
export function assertBrowserWritableMediaPath(cloudPath: string): void {
  const parts = typeof cloudPath === 'string' ? cloudPath.split('/').filter(Boolean) : [];
  if (
    parts.length === 0 ||
    cloudPath.includes('%') ||
    cloudPath.includes('\\') ||
    parts.some((part) => part === '.' || part === '..') ||
    (parts[0] === 'catalog' && parts[1] === 'sealed')
  )
    throw new Error('Reserved or invalid media upload path');
}

export function assertProtectedMediaCheckpoint(namespace: string, beforeWrite: unknown): void {
  if (namespace === 'catalog-sealed' && typeof beforeWrite !== 'function')
    throw new Error('Protected media write requires a durable checkpoint');
}
