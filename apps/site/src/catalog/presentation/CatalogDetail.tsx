import { type ReactNode, useContext } from 'react';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import type { DetailPages } from '../application/catalog-detail-pages.ts';
import { CatalogLocalPreviewContext } from '../application/catalog-quote-transport.ts';
import type { VariantSelection } from '../application/catalog-variant-state.ts';
import { CatalogDescriptionImages } from './CatalogDescriptionImages.tsx';
import { CatalogQuotePanel } from './CatalogQuotePanel.tsx';
import { CatalogSkuDisclosure } from './CatalogSkuDisclosure.tsx';
import { CatalogSpecifications } from './CatalogSpecifications.tsx';
import { CatalogVariantSelector } from './CatalogVariantSelector.tsx';
import { catalogContentView } from './catalog-content-view.ts';
export interface CatalogDetailProps {
  pages: DetailPages;
  selection: VariantSelection;
  copy: SharedDetailContent;
  media: ReactNode;
  onSelect: (id: string) => void;
  onClear: () => void;
  pagination?: ReactNode;
  backNavigation?: ReactNode;
  /** Admin previews share the buyer layout, but never create buyer inquiries. */
  inquiryEnabled?: boolean;
  descriptionMedia?: ReactNode;
}
export function CatalogDetail({
  pages,
  selection,
  copy,
  media,
  onSelect,
  onClear,
  pagination,
  backNavigation,
  inquiryEnabled = true,
  descriptionMedia,
}: CatalogDetailProps) {
  const detail = pages.currentPage;
  const localPreview = useContext(CatalogLocalPreviewContext);
  const content = 'content' in detail ? detail.content : undefined;
  const { highlights } = catalogContentView(detail.facts, content);
  return (
    <article
      data-shared-catalog-detail={detail._id}
      className="bg-white pb-16 pt-6 text-ink lg:pb-20 lg:pt-8"
    >
      <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
        {backNavigation !== undefined ? (
          backNavigation
        ) : (
          <a
            href="/electronics-toys/"
            className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-brand-700 focus-visible:outline-brand-700"
          >
            <span aria-hidden="true">←</span>
            {copy.backLabel}
          </a>
        )}
        {localPreview && (
          <div className="mb-6 mt-2 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-xs leading-relaxed text-brand-800">
            <strong className="mr-2">{copy.previewLabel}</strong>
            {copy.previewNote}
          </div>
        )}
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,.46fr)_minmax(0,.54fr)] lg:gap-x-12 lg:gap-y-6">
          <header className="min-w-0 lg:col-start-2 lg:row-start-1">
            {detail.categoryLabel && (
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-brand-700">
                {detail.categoryLabel}
              </p>
            )}
            <h1
              data-shared-detail-heading
              tabIndex={-1}
              className="break-words font-display text-2xl font-semibold leading-tight tracking-tight text-brand-950 sm:text-3xl lg:text-[2rem]"
            >
              {detail.name}
            </h1>
            {highlights.length > 0 && (
              <section data-catalog-key-facts className="mt-5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                  {copy.keyFactsLabel}
                </h2>
                <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
                  {highlights.map((fact) => (
                    <div key={fact.name} className="min-w-0 border-l-2 border-brand-200 pl-3">
                      <dt className="text-xs text-ink-muted">{fact.name}</dt>
                      <dd className="mt-1 break-words text-sm font-semibold text-ink">
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </header>
          <div className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1">
            {media}
            <p className="mt-4 text-xs leading-relaxed text-ink-muted">{copy.imagesNote}</p>
          </div>
          <div className="min-w-0 space-y-6 lg:col-start-2 lg:row-start-2">
            <CatalogVariantSelector
              pages={pages}
              selection={selection}
              copy={copy}
              onSelect={onSelect}
            />
            {pagination}
            {selection.status === 'selected' ? (
              <CatalogSkuDisclosure variant={selection.variant} copy={copy} />
            ) : selection.status === 'pending' || selection.status === 'invalid' ? (
              <div
                aria-live="polite"
                className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-ink-soft"
              >
                <p>{selection.status === 'pending' ? copy.pendingLabel : copy.invalidVariant}</p>
                <button
                  type="button"
                  onClick={onClear}
                  className="mt-2 min-h-11 font-semibold text-brand-700 underline"
                >
                  {copy.clearLabel}
                </button>
              </div>
            ) : null}
            <CatalogQuotePanel
              key={`${detail._id}:${detail.revision}`}
              detail={detail}
              selection={selection}
              copy={copy}
              inquiryEnabled={inquiryEnabled}
            />
          </div>
        </div>
        <CatalogSpecifications
          facts={detail.facts}
          description={detail.descriptionText}
          content={content}
          noteBlocks={'noteBlocks' in detail ? detail.noteBlocks : undefined}
          copy={copy}
          hasDescriptionImages={Boolean(detail.descriptionImages?.length || descriptionMedia)}
        />
        {descriptionMedia !== undefined ? (
          descriptionMedia
        ) : (
          <CatalogDescriptionImages images={detail.descriptionImages ?? []} />
        )}
      </div>
    </article>
  );
}
