import type { APIRoute, GetStaticPaths } from 'astro';
import { type BlogAsset, readBlogBuild } from '../../../../lib/blog/snapshot.ts';
export const getStaticPaths: GetStaticPaths = async () => {
  const { assets } = await readBlogBuild(process.env.SITE_URL || 'http://localhost:4321');
  return assets.map((asset) => ({
    params: { asset: asset.path.slice('/media/articles/'.length) },
    props: { asset },
  }));
};
export const GET: APIRoute = ({ props }) => {
  const { asset } = props as { asset: BlogAsset };
  return new Response(new Uint8Array(asset.bytes), { headers: { 'Content-Type': asset.mimeType } });
};
