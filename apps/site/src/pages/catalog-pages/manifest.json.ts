import { categoryManifest } from '../../lib/seo/category-snapshot.ts';
import { readProductSnapshot } from '../../lib/seo/product-snapshot.ts';

export async function GET() {
  const snapshot = await readProductSnapshot(import.meta.env.SITE_URL || 'http://localhost:4321');
  return Response.json(categoryManifest(snapshot));
}
