import { useEffect, useMemo, useState } from 'react';
import { CatalogDetailController } from '../../catalog/application/CatalogDetailController.tsx';
import { CatalogQuoteTransportContext } from '../../catalog/application/catalog-quote-transport.ts';
import { submitPublicQuote } from '../../catalog/application/public-quote-transport.ts';
import type { DetailPage } from '../../catalog/infrastructure/catalog-detail-api.ts';
import type { CatalogContent, SharedDetailContent } from '../../i18n/catalog.ts';
import { CatalogHeroImageApiOrigin } from './ProductMedia.tsx';
import { LegacySkuDetailPage } from './SkuDetailPage.tsx';
import type { Product } from './catalog-types.ts';

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
  const presentedBootstrap = useMemo(() => {
    if (!bootstrap || !product.imagePresentation) return bootstrap;
    const sources = new Set([
      ...bootstrap.images,
      ...bootstrap.variants.items.flatMap((variant) => variant.images),
    ]);
    const imagePresentation = Object.fromEntries(
      Object.entries(product.imagePresentation).filter(([source]) => sources.has(source)),
    );
    return {
      ...bootstrap,
      imagePresentation: { ...imagePresentation, ...bootstrap.imagePresentation },
    };
  }, [bootstrap, product.imagePresentation]);
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
