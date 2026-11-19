import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { factoryVideoRangePath } from './factory-video.ts';
import {
  WatchVideoSchema,
  publicWatchVideo,
  publicWatchVideos,
  videoObject,
  watchPageDescriptor,
  watchVideoPath,
  watchVideoSources,
  watchVideos,
  withVideoSitemapMetadata,
} from './video-record.ts';

const origin = 'https://example.test';
const video = watchVideos[0];
assert.ok(video);
test('public watch metadata binds the actual existing video and exact extracted poster', () => {
  const source = readFileSync(new URL(`../../../public${video.src}`, import.meta.url));
  const poster = readFileSync(new URL(`../../../public${video.poster.src}`, import.meta.url));
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(source.length, video.byteSize);
  assert.equal(sha(source), video.sourceSha256);
  assert.equal(sha(poster), video.poster.sha256);
  assert.equal(video.durationSeconds, 130.733333);
  assert.equal(video.audioTracks, 0);
  assert.deepEqual([video.width, video.height], [960, 720]);
});
test('withdrawn and unknown videos do not have public discovery or structured data', () => {
  assert.equal(publicWatchVideo('factory-overview')?.src, video.src);
  assert.equal(publicWatchVideo('unknown'), undefined);
  const withdrawn = { ...video, status: 'withdrawn' as const };
  assert.deepEqual(publicWatchVideos([withdrawn]), []);
  assert.equal(videoObject(withdrawn, origin), null);
  assert.throws(() => watchPageDescriptor(withdrawn, origin, 'Example'), /Withdrawn/);
  const item = { url: `${origin}${watchVideoPath(video)}` };
  assert.equal(withVideoSitemapMetadata(item, origin, true, [withdrawn]), item);
});
test('an unknown original publication date is never replaced with the build date', () => {
  assert.equal(videoObject(video, origin), null);
  const item = withVideoSitemapMetadata({ url: `${origin}${watchVideoPath(video)}` }, origin, true);
  assert.ok(item.video);
  assert.equal(item.video.length, 1);
  assert.equal(Object.hasOwn(item.video[0], 'publication_date'), false);
  assert.equal(item.video[0]?.duration, 131);
  assert.equal(item.video[0]?.content_loc, `${origin}${factoryVideoRangePath}`);
  assert.equal(item.video[0]?.thumbnail_loc, `${origin}${video.poster.src}`);
});
test('verified dates and sources produce complete metadata using the same actual video URLs', () => {
  const verified = {
    ...video,
    publication: {
      status: 'verified' as const,
      at: '2024-03-14T12:00:00+08:00',
      evidence: 'Synthetic date fixture only',
    },
  };
  const schema = videoObject(verified, origin, true);
  assert.ok(schema);
  assert.equal(schema.uploadDate, verified.publication.at);
  assert.equal(schema.contentUrl, `${origin}${factoryVideoRangePath}`);
  assert.equal(schema.url, `${origin}${watchVideoPath(video)}`);
  const item = withVideoSitemapMetadata({ url: String(schema.url) }, origin, true, [verified]);
  assert.ok(item.video);
  assert.equal(item.video[0]?.publication_date, schema.uploadDate);
  assert.equal(item.video[0]?.content_loc, schema.contentUrl);
});
test('ordinary sitemap entries remain unchanged and unsafe media metadata fails closed', () => {
  const ordinary = { url: `${origin}/oem/`, lastmod: '2026-01-01' };
  assert.equal(withVideoSitemapMetadata(ordinary, origin, true), ordinary);
  for (const patch of [
    { src: 'https://other.invalid/file.mp4' },
    { src: '/media/../private.mp4' },
    { durationSeconds: 0 },
    { publication: { status: 'verified', at: 'today', evidence: 'unknown' } },
  ])
    assert.equal(WatchVideoSchema.safeParse({ ...video, ...patch }).success, false);
  assert.throws(() => publicWatchVideos([video, video]), /Duplicate/);
  assert.throws(
    () => withVideoSitemapMetadata(ordinary, 'https://user:secret@example.test', true),
    /SITE_URL/,
  );
});

test('watch player and sitemap use the same available source in both deployment modes', () => {
  const entry = { url: `${origin}${watchVideoPath(video)}` };
  assert.deepEqual(watchVideoSources(video, true), [factoryVideoRangePath, video.src]);
  assert.deepEqual(watchVideoSources(video, false), [video.src]);
  assert.equal(
    withVideoSitemapMetadata(entry, origin, false).video?.[0]?.content_loc,
    `${origin}${video.src}`,
  );
  const differentVideo = { ...video, sourceSha256: '1'.repeat(64) };
  assert.deepEqual(watchVideoSources(differentVideo, true), [video.src]);
});
