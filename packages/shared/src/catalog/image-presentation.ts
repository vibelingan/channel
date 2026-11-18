import { z } from 'zod';

const publicImage = /^(?:https:\/\/[^/?#]+)?\/api\/images\/[A-Za-z0-9_-]+$/;
export const CatalogImagePresentationSchema = z
  .record(
    z.string().max(2200).regex(publicImage),
    z
      .array(
        z
          .object({
            url: z.string().max(2220),
            width: z.number().int().min(1).max(1280),
            height: z.number().int().min(1).max(16383),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  )
  .superRefine((map, ctx) => {
    for (const [source, candidates] of Object.entries(map)) {
      const widths = new Set<number>();
      for (const candidate of candidates) {
        if (
          ![160, 640, 1280].some(
            (width) => candidate.url === `${source}?w=${width}` && candidate.width <= width,
          ) ||
          widths.has(candidate.width)
        )
          ctx.addIssue({
            code: 'custom',
            path: [source],
            message: 'Image candidates must preserve their source and unique actual pixel widths',
          });
        widths.add(candidate.width);
      }
    }
  });
export type CatalogImagePresentation = z.infer<typeof CatalogImagePresentationSchema>;

export function imagePresentationMatchesSources(
  map: CatalogImagePresentation,
  sources: readonly string[],
) {
  const allowed = new Set(sources);
  return Object.keys(map).every((source) => allowed.has(source));
}
