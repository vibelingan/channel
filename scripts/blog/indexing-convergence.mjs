export class BlogExposureConflict extends Error {}

/** Wait for read-only checks on both entry points after CloudBase finishes releasing. */
export async function waitForBlogIndexing({
  read,
  releaseId,
  previewOnly,
  now = Date.now,
  pause = () => new Promise((done) => setTimeout(done, 2000)),
  timeoutMs = 90000,
}) {
  const deadline = now() + timeoutMs;
  let observed = 'No response';
  while (now() < deadline) {
    let value;
    try {
      value = await read();
    } catch {
      observed = 'A Blog entry point did not return a verified response';
    }
    if (value) {
      if (value.releaseId !== releaseId || value.temporaryReleaseId !== releaseId)
        throw new BlogExposureConflict(
          'A Blog entry point changed program during configuration release',
        );
      observed = JSON.stringify(value);
      if (
        value.previewOnly === previewOnly &&
        value.formalNoindex === previewOnly &&
        value.temporaryNoindex === true
      )
        return;
    }
    await pause();
  }
  throw Error(`Blog entry points did not converge to previewOnly=${previewOnly}: ${observed}`);
}
