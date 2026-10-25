import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { validateBlogOutput } from '../blog/output.ts';
import { validateSiteOutput } from './output-gate.ts';

export function seoGate(origin: string, options: { blogServer?: boolean } = {}): AstroIntegration {
  return {
    name: 'channel-rendered-seo-gate',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const directory = fileURLToPath(dir);
        // CloudBase reserves /404.html; its fallback must point to an ordinary object.
        await mkdir(join(directory, 'errors'), { recursive: true });
        await copyFile(join(directory, '404.html'), join(directory, 'errors/not-found.html'));
        const entries = await validateSiteOutput(directory, origin, options);
        if (options.blogServer) {
          if (entries.some((entry) => entry.path.startsWith('/blog/')))
            throw Error('Server Blog must not leave static article HTML in the deployment output');
        } else await validateBlogOutput(fileURLToPath(dir), origin, entries);
        logger.info(
          `Verified ${entries.length} HTML pages, ${entries.filter((entry) => entry.robots === 'index,follow').length} indexable canonical URLs, sitemap and ownership files.`,
        );
      },
    },
  };
}
