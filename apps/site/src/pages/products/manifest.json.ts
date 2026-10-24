import type { APIRoute } from 'astro';
import { productPath } from '../../lib/seo/product-identity.ts';
import { readProductSnapshot } from '../../lib/seo/product-snapshot.ts';

/** Public build inventory, never the raw product DTO or an admin snapshot. */
export const GET: APIRoute = async () => {
  const snapshot = await readProductSnapshot(import.meta.env.SITE_URL || 'http://localhost:4321');
  return Response.json({
    schemaVersion: 1,
    purpose: snapshot.purpose,
    siteOrigin: snapshot.siteOrigin,
    total: snapshot.total,
    products: snapshot.products.map((entry) => ({
      path: productPath(entry.product._id),
      revision: entry.revision,
    })),
  });
};
