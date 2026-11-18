import { checkFunctionArchive } from './function-archive.mjs';
import { identity, sha256 } from './input.mjs';

/** One code-only expansion; failed health may recover known B once, never an unknown package or changed config. */
export async function replaceFunctionCode({
  name = 'admin',
  provider,
  before,
  original,
  candidate,
  beforeVersion,
  expectedVersion,
  readHealth,
  archiveProfile = 'bundled',
  timeoutMs = 180000,
  now = Date.now,
  pause = () => new Promise((done) => setTimeout(done, 2000)),
  report = (_event) => {},
  verifyCandidate = undefined,
}) {
  const reportFailure = (stage, error) => {
    const diagnostic = {};
    for (const key of ['code', 'causeCode', 'stage', 'requestId', 'parameterHint', 'reasonHint']) {
      const value = error?.[key];
      if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value))
        diagnostic[key] = value;
    }
    try {
      report({ stage, diagnostic });
    } catch {
      // Diagnostic output cannot alter deployment or recovery decisions.
    }
  };
  if (
    !['admin', 'public-api', 'alibaba-catalog-sync'].includes(name) ||
    before.name !== name ||
    sha256(original) !== before.packageSha256 ||
    !beforeVersion ||
    !expectedVersion
  )
    throw new Error('A verified original and a distinct runtime version are required');
  if (archiveProfile === 'catalog-native-decoder' && name !== 'alibaba-catalog-sync')
    throw Error('Native archive profile is outside the fixed synchronization function');
  if (verifyCandidate !== undefined && typeof verifyCandidate !== 'function')
    throw Error('Candidate endpoint verification must be a function');
  const originalFiles = checkFunctionArchive(original, { profile: archiveProfile });
  const candidateFiles = checkFunctionArchive(candidate, { profile: archiveProfile });
  const expectedHash = sha256(candidate);
  // Only an explicit false is a confirmed rejection. A failed observation cannot authorize recovery.
  async function verifyKnownCandidate(snapshot) {
    if (!verifyCandidate) return { status: 'accepted', snapshot };
    try {
      const valid = await verifyCandidate();
      if (valid !== true && valid !== false) return { status: 'unknown', snapshot };
      const current = await provider.inspect(name);
      // Pin observed installed bytes; identical code may be repacked with a different ZIP timestamp.
      if (
        current.configurationToken !== before.configurationToken ||
        current.packageSha256 !== snapshot.packageSha256 ||
        current.status !== 'Active' ||
        current.availableStatus !== 'Available'
      )
        return { status: 'unknown', snapshot: current };
      return { status: valid ? 'accepted' : 'unhealthy', snapshot: current };
    } catch (error) {
      reportFailure('candidate-verification-unconfirmed', error);
      return { status: 'unknown', snapshot };
    }
  }
  if (beforeVersion === expectedVersion) {
    if (identity(originalFiles.contentSha256) !== identity(candidateFiles.contentSha256))
      throw new Error('Same runtime version has different program bytes');
    const current = await provider.inspect(name);
    if (
      current.packageSha256 !== before.packageSha256 ||
      current.configurationToken !== before.configurationToken ||
      current.status !== 'Active' ||
      current.availableStatus !== 'Available' ||
      (await readHealth()) !== expectedVersion
    )
      throw new Error('Existing version could not be independently confirmed');
    await pause();
    if ((await readHealth()) !== expectedVersion)
      throw new Error('Existing version health changed');
    const verified = await verifyKnownCandidate(current);
    return verified.status === 'accepted'
      ? { ...verified, alreadyInstalled: true }
      : { ...verified, status: 'unknown' };
  }
  const submit = (bytes, expectedSnapshot) =>
    provider.updateCode({
      name,
      runtime: before.runtime,
      handler: before.handler,
      bytes,
      sha256: sha256(bytes),
      expectedSnapshot,
    });
  async function observe(hash, version) {
    const deadline = now() + timeoutMs;
    let latest;
    let stable = 0;
    for (;;) {
      latest = await provider.inspect(name);
      if (latest.configurationToken !== before.configurationToken)
        return { status: 'unknown', snapshot: latest };
      if (latest.status === 'Active' && latest.availableStatus === 'Available') {
        if (latest.packageSha256 !== hash) return { status: 'different', snapshot: latest };
        let health;
        try {
          health = await readHealth();
        } catch {
          health = null;
        }
        stable = health === version ? stable + 1 : 0;
        if (stable === 2) return { status: 'accepted', snapshot: latest };
      }
      if (now() >= deadline) return { status: 'unhealthy', snapshot: latest };
      await pause();
    }
  }
  try {
    await submit(candidate, before);
  } catch (error) {
    reportFailure('code-submission-unconfirmed', error);
    /* An acknowledgement alone cannot decide the result. */
  }
  let result;
  try {
    result = await observe(expectedHash, expectedVersion);
  } catch (error) {
    reportFailure('code-observation-unconfirmed', error);
    return { status: 'unknown' };
  }
  if (result.status === 'accepted') {
    result = await verifyKnownCandidate(result.snapshot);
    if (result.status === 'accepted' || result.status === 'unknown') return result;
  }
  const current = result.snapshot;
  if (!current || current.configurationToken !== before.configurationToken)
    return { status: 'unknown' };
  if (current.packageSha256 === before.packageSha256) {
    const unchanged = await observe(before.packageSha256, beforeVersion);
    return unchanged.status === 'accepted'
      ? { ...unchanged, status: 'not-written' }
      : { status: 'unknown' };
  }
  if (
    current.status !== 'Active' ||
    current.availableStatus !== 'Available' ||
    current.packageSha256 !== expectedHash
  )
    return { status: 'unknown' };
  try {
    await submit(original, current);
  } catch (error) {
    reportFailure('recovery-submission-unconfirmed', error);
    /* Read back once; never submit a second recovery. */
  }
  try {
    const recovered = await observe(before.packageSha256, beforeVersion);
    return recovered.status === 'accepted'
      ? { ...recovered, status: 'restored' }
      : { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}
