import { useEffect, useMemo, useState } from 'react';
import { CatalogDetailController } from '../../catalog/application/CatalogDetailController.tsx';
import { initialProductDetailState } from '../../catalog/application/catalog-product-detail-state.ts';
import { CatalogQuoteTransportContext } from '../../catalog/application/catalog-quote-transport.ts';
import { submitPublicQuote } from '../../catalog/application/public-quote-transport.ts';
import type { DetailPage } from '../../catalog/infrastructure/catalog-detail-api.ts';
import { catalogVariantGalleryPhotos } from '../../catalog/presentation/CatalogVariantGallery.tsx';
import {
  catalogGalleryImageSizes,
  responsiveImageAttributes,
  siteCatalogImagePath,
} from '../../catalog/presentation/responsive-images.ts';
import type { CatalogContent, SharedDetailContent } from '../../i18n/catalog.ts';
import { CatalogHeroImageApiOrigin } from './ProductMedia.tsx';
import { LegacySkuDetailPage } from './SkuDetailPage.tsx';
import type { Product } from './catalog-types.ts';

function addGalleryImagePresentation(
  bootstrap: DetailPage | undefined,
  presentation: Product['imagePresentation'],
): DetailPage | undefined {
  if (!bootstrap || !presentation) return bootstrap;
  const sources = new Set([
    ...bootstrap.images,
    ...bootstrap.variants.items.flatMap((variant) => variant.images),
  ]);
  const imagePresentation = Object.fromEntries(
    Object.entries(presentation).filter(([source]) => sources.has(source)),
  );
  return {
    ...bootstrap,
    imagePresentation: { ...imagePresentation, ...bootstrap.imagePresentation },
  };
}

/** Only preload the exact responsive file the static gallery can reuse on this site. */
export function initialProductImagePreload(
  product: Product,
  bootstrap: DetailPage | undefined,
  apiOrigin: string | undefined,
) {
  if (!apiOrigin || !bootstrap || (!bootstrap.imagePresentation && !product.imagePresentation)) {
    return undefined;
  }
  const detail = initialProductDetailState(
    addGalleryImagePresentation(bootstrap, product.imagePresentation),
  );
  if (detail.status !== 'ready' || detail.productId !== product._id) return undefined;

  const { photos } = catalogVariantGalleryPhotos({
    images: detail.pages.currentPage.images,
    selection: detail.selection,
  });
  const source = photos[0];
  const sitePath = (url: string) => siteCatalogImagePath(new URL(url, apiOrigin).href, apiOrigin);
  if (!source || !sitePath(source)) return undefined;
  const attrs = responsiveImageAttributes(
    source,
    detail.pages.imagePresentation,
    catalogGalleryImageSizes,
    (url) => sitePath(url) ?? url,
  );
  if (!attrs.srcSet) return undefined;
  return attrs;
}

/** Same buyer UI and quote transport as category expansion, with an HTML bootstrap. */
export function ProductLanding({
  product,
  bootstrap,
  content,
  copy,
  canonicalPath,
  heroImageApiOrigin,
}: {
  product: Product;
  bootstrap?: DetailPage;
  content: CatalogContent;
  copy: SharedDetailContent;
  canonicalPath: string;
  heroImageApiOrigin?: string | undefined;
}) {
  const [variant, setVariant] = useState<string>();
  const presentedBootstrap = useMemo(
    () => addGalleryImagePresentation(bootstrap, product.imagePresentation),
    [bootstrap, product.imagePresentation],
  );
  useEffect(() => {
    const read = () =>
      setVariant(new URLSearchParams(window.location.search).get('variant') ?? undefined);
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  if (!bootstrap)
    return (
      <LegacySkuDetailPage
        content={content}
        productId={product._id}
        initialProduct={product}
        canonicalPath={canonicalPath}
      />
    );
  return (
    <CatalogHeroImageApiOrigin.Provider value={heroImageApiOrigin}>
      <CatalogQuoteTransportContext.Provider value={submitPublicQuote}>
        <CatalogDetailController
          productId={product._id}
          bootstrap={presentedBootstrap ?? bootstrap}
          copy={copy}
          requestedId={variant}
          onVariantChange={(id) => {
            const params = new URLSearchParams(window.location.search);
            if (id) params.set('variant', id);
            else params.delete('variant');
            window.history.replaceState(
              window.history.state,
              '',
              `${canonicalPath}${params.size ? `?${params}` : ''}${window.location.hash}`,
            );
            setVariant(id);
          }}
        />
      </CatalogQuoteTransportContext.Provider>
    </CatalogHeroImageApiOrigin.Provider>
  );
}
