/** Server-owned destinations. The namespace alone is not a readiness or immutability proof. */
export function catalogProtectedStoragePath(logicalId: string, fileName: string): string {
  const identity = /^([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(logicalId);
  const name = /^original\.(jpg|jpeg|png|gif|webp)$/.exec(fileName);
  if (!identity || !name) throw new Error('Invalid protected catalog storage identity');
  return `catalog/sealed/${identity[1]}/${identity[2]}/${identity[3]}.${name[1]}`;
}

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
