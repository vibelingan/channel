/** Server-owned destinations. The namespace alone is not a readiness or immutability proof. */
export function catalogProtectedStoragePath(logicalId: string, fileName: string): string {
  const identity = /^([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(logicalId);
  const name = /^original\.(jpg|jpeg|png|gif|webp)$/.exec(fileName);
  if (!identity || !name) throw new Error('Invalid protected catalog storage identity');
  return `catalog/sealed/${identity[1]}/${identity[2]}/${identity[3]}.${name[1]}`;
}

/** Immutable path; server callers provide the image identity digest. Browser safe. */
export function catalogWebObjectPath(
  imageSha: string,
  sourceSha: string,
  outputSha: string,
): string {
  if (![imageSha, sourceSha, outputSha].every((x) => /^[a-f0-9]{64}$/.test(x)))
    throw Error('Invalid catalog web image identity');
  return `catalog-web/v1/${imageSha}/${sourceSha}/${outputSha}.webp`;
}
