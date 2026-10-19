import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { validateSiteOutput } from './output-gate.ts';

export function seoGate(origin: string): AstroIntegration {
  return {
    name: 'channel-rendered-seo-gate',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const entries = await validateSiteOutput(fileURLToPath(dir), origin);
        logger.info(
          `Verified ${entries.length} HTML pages, ${entries.filter((entry) => entry.robots === 'index,follow').length} indexable canonical URLs, sitemap and ownership files.`,
        );
      },
    },
  };
}
