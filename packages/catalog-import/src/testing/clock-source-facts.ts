/** Captured specification values only; private source identities and transports are omitted. */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const clockFactsSamples = z
  .object({
    samples: z
      .array(
        z.object({
          specimen: z.string(),
          attributes: z.array(
            z.object({
              sourceName: z.string(),
              value: z.union([z.string(), z.number(), z.boolean()]),
            }),
          ),
        }),
      )
      .min(1),
  })
  .parse(
    JSON.parse(readFileSync(new URL('./clock-source-facts.json', import.meta.url), 'utf8')),
  ).samples;
