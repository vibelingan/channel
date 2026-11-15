import { verifyCatalogRenderer } from './catalog-renderer.mjs';
import { sha256 } from './input.mjs';
export function createRendererSource({ objects }) {
  return {
    async download(approved) {
      if (
        approved?.schemaVersion !== 1 ||
        approved.manifestObject?.sha256 !== approved.manifestSha256 ||
        approved.archiveObject?.sha256 !== approved.archiveSha256
      )
        throw Error('Approved renderer object references differ');
      const bytes = await objects.get(approved.manifestObject);
      if (sha256(bytes) !== approved.manifestSha256) throw Error('Renderer manifest differs');
      const manifest = JSON.parse(bytes.toString());
      const archive = await objects.get(approved.archiveObject);
      const proof = verifyCatalogRenderer({ manifest, approved, archive });
      return { manifest, archive, proof };
    },
  };
}
