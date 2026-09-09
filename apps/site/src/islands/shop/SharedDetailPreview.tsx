import { type ReactNode, useEffect, useState } from 'react';
import { CatalogDetailController } from '../../catalog/application/CatalogDetailController.tsx';
import {
  CatalogLocalPreviewContext,
  CatalogQuoteTransportContext,
} from '../../catalog/application/catalog-quote-transport.ts';
import { submitLocalQuote } from '../../catalog/application/local-quote-transport.ts';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { sharedVariantSearch } from './shared-detail-navigation.ts';
import { sharedPreviewTarget } from './shared-detail-preview-target.ts';

/** Development-only route adapter. Never mount the legacy fetcher for an ID preview. */
export default function SharedDetailPreview({
  copy,
  legacy,
}: { copy: SharedDetailContent; legacy: ReactNode }) {
  const [search, setSearch] = useState<string>();
  useEffect(() => {
    const read = () => setSearch(window.location.search);
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  if (search === undefined)
    return <output className="block p-12 text-center">{copy.loadingLabel}</output>;
  const target = sharedPreviewTarget(true, search);
  if (target.status === 'legacy') return legacy;
  if (target.status !== 'preview')
    return (
      <p role="alert" className="p-12 text-center">
        {copy.errorLabel}
      </p>
    );
  return (
    <CatalogLocalPreviewContext.Provider value={true}>
      <CatalogQuoteTransportContext.Provider value={submitLocalQuote}>
        <CatalogDetailController
          key={JSON.stringify([target.productId, target.requestedId])}
          productId={target.productId}
          requestedId={target.requestedId}
          copy={copy}
          onVariantChange={(variantId) => {
            const next = sharedVariantSearch(window.location.search, variantId);
            if (next !== undefined)
              window.history.replaceState(
                window.history.state,
                '',
                `${window.location.pathname}${next}`,
              );
          }}
        />
      </CatalogQuoteTransportContext.Provider>
    </CatalogLocalPreviewContext.Provider>
  );
}
