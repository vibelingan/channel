import { z } from 'zod';
import { factoryVideoAsset, factoryVideoRangePath } from './factory-video.ts';
import { canonicalUrl, createPageDescriptor, siteOrigin } from './page.ts';

const mediaPath = (extension: string) =>
  z.string().regex(new RegExp(`^/media/[A-Za-z0-9/_-]+\\.${extension}$`));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const WatchVideoSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status: z.enum(['public', 'withdrawn']),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2048),
    src: mediaPath('mp4'),
    sourceSha256: hash,
    byteSize: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSeconds: z.number().finite().min(1).max(28800),
    audioTracks: z.literal(0),
    poster: z
      .object({
        src: mediaPath('webp'),
        sha256: hash,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        frameSeconds: z.number().finite().nonnegative(),
      })
      .strict(),
    publication: z.discriminatedUnion('status', [
      z.object({ status: z.literal('unverified') }).strict(),
      z
        .object({
          status: z.literal('verified'),
          at: z.string().datetime({ offset: true }),
          evidence: z.string().trim().min(1),
        })
        .strict(),
    ]),
    sceneSummary: z
      .array(z.object({ heading: z.string().min(1), text: z.string().min(1) }).strict())
      .min(1),
  })
  .strict()
  .refine(
    (video) => video.poster.frameSeconds < video.durationSeconds,
    'Poster frame must belong to the video',
  );
export type WatchVideo = z.infer<typeof WatchVideoSchema>;

// Existing client-supplied OEM.mp4. Facts and hashes were measured from this exact asset.
// See docs/seo/continuation/next-phase-design-2026-11-05/evidence/video-factory-20261117.json.
export const watchVideos: readonly WatchVideo[] = [
  WatchVideoSchema.parse({
    id: 'factory-overview',
    status: 'public',
    title: 'Factory & workshop overview',
    description: 'A silent factory tour showing offices, tooling, moulding and assembly work.',
    src: factoryVideoAsset.source,
    sourceSha256: factoryVideoAsset.sha256,
    byteSize: factoryVideoAsset.bytes,
    width: 960,
    height: 720,
    durationSeconds: 130.733333,
    audioTracks: 0,
    poster: {
      src: '/media/factory-overview-c215171947e5.webp',
      sha256: 'c215171947e5ae04aa2c6a24281be781b90f49526a6b62f6cb2249a6f4d42e39',
      width: 960,
      height: 720,
      frameSeconds: 2,
    },
    publication: { status: 'unverified' },
    sceneSummary: [
      {
        heading: 'Site and offices',
        text: 'The tour opens with exterior views of the premises and people working in office areas.',
      },
      {
        heading: 'Tooling and machine work',
        text: 'Workshop scenes show tooling, machining and moulding equipment in operation.',
      },
      {
        heading: 'Assembly and production areas',
        text: 'The later scenes show workstations, assembly lines and people handling components and products.',
      },
    ],
  }),
];

export function publicWatchVideos(
  records: readonly WatchVideo[] = watchVideos,
): readonly WatchVideo[] {
  const parsed = records.map((record) => WatchVideoSchema.parse(record));
  if (new Set(parsed.map((record) => record.id)).size !== parsed.length)
    throw Error('Duplicate watch video identity');
  return parsed.filter((record) => record.status === 'public');
}
export function publicWatchVideo(id: string): WatchVideo | undefined {
  return publicWatchVideos().find((record) => record.id === id);
}
export function watchVideoPath(video: WatchVideo): string {
  return `/videos/${video.id}/`;
}

export function watchVideoSources(
  video: WatchVideo,
  blogServer: boolean,
): readonly [string, ...string[]] {
  if (
    blogServer &&
    video.src === factoryVideoAsset.source &&
    video.sourceSha256 === factoryVideoAsset.sha256
  ) {
    return [factoryVideoRangePath, video.src];
  }
  return [video.src];
}

export function watchPageDescriptor(
  video: WatchVideo,
  originInput: string | URL,
  brand: string,
  blogServer = false,
) {
  const record = WatchVideoSchema.parse(video);
  if (record.status !== 'public') throw Error('Withdrawn videos have no public watch page');
  const origin = siteOrigin(originInput);
  const path = watchVideoPath(record);
  const url = canonicalUrl(path, origin);
  const schema = videoObject(record, origin, blogServer);
  return createPageDescriptor({
    path,
    kind: 'marketing',
    title: `${record.title} | ${brand}`,
    description: record.description,
    content: { source: 'curated-public-video', revision: record.sourceSha256 },
    schemaNodes: [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: new URL('/', origin).href },
          { '@type': 'ListItem', position: 2, name: record.title, item: url },
        ],
      },
      ...(schema ? [schema] : []),
    ],
  });
}

/** Unknown historical dates stay absent; a new build is not a new video publication. */
export function videoObject(
  video: WatchVideo,
  originInput: string | URL,
  blogServer = false,
): Record<string, unknown> | null {
  const record = WatchVideoSchema.parse(video);
  if (record.status !== 'public' || record.publication.status !== 'verified') return null;
  const origin = siteOrigin(originInput);
  const url = canonicalUrl(watchVideoPath(record), origin);
  return {
    '@type': 'VideoObject',
    '@id': `${url}#video`,
    url,
    name: record.title,
    description: record.description,
    contentUrl: new URL(watchVideoSources(record, blogServer)[0], origin).href,
    thumbnailUrl: new URL(record.poster.src, origin).href,
    uploadDate: record.publication.at,
    duration: `PT${record.durationSeconds}S`,
  };
}

/** The installed Astro integration passes this extension to its actual sitemap serializer. */
interface SitemapVideo {
  title: string;
  description: string;
  thumbnail_loc: string;
  content_loc: string;
  duration: number;
  publication_date?: string;
}
export function withVideoSitemapMetadata<T extends { url: string }>(
  item: T,
  originInput: string | URL,
  blogServer: boolean,
  records: readonly WatchVideo[] = watchVideos,
): T & { video?: SitemapVideo[] } {
  const origin = siteOrigin(originInput);
  const video = publicWatchVideos(records).find(
    (record) => canonicalUrl(watchVideoPath(record), origin) === item.url,
  );
  if (!video) return item;
  return {
    ...item,
    video: [
      {
        title: video.title,
        description: video.description,
        thumbnail_loc: new URL(video.poster.src, origin).href,
        content_loc: new URL(watchVideoSources(video, blogServer)[0], origin).href,
        duration: Math.round(video.durationSeconds),
        ...(video.publication.status === 'verified'
          ? { publication_date: video.publication.at }
          : {}),
      },
    ],
  };
}
