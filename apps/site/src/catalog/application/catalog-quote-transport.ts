import type { CatalogQuoteSubmission } from '@vibelingan-channel/shared/catalog-quote';
import { createContext } from 'react';

export type CatalogQuoteTransport = (
  request: CatalogQuoteSubmission,
) => Promise<{ ok: true; requestId: string } | { ok: false; code: string }>;
/** Missing transport is intentional: a form must never fall back to OEM. */
export const CatalogQuoteTransportContext = createContext<CatalogQuoteTransport | undefined>(
  undefined,
);
/** Presentation only; never enables a route, transport, or backend capability. */
export const CatalogLocalPreviewContext = createContext(false);
