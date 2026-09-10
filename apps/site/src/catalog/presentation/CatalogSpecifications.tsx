import type {
  CatalogContent,
  CatalogNoteBlocks,
  CatalogProductDetail,
} from '@vibelingan-channel/shared/catalog-detail';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { catalogContentView } from './catalog-content-view.ts';

function FactRows({ rows }: { rows: CatalogProductDetail['facts'] }) {
  return (
    <dl className="mt-5 grid gap-x-10 md:grid-cols-2">
      {rows.map((row, index) => (
        <div
          key={`${index}:${row.name}`}
          className="grid grid-cols-[minmax(0,.42fr)_minmax(0,.58fr)] gap-4 border-t border-slate-200 py-4 text-sm leading-6"
        >
          <dt className="break-words text-ink-muted">{row.name}</dt>
          <dd className="break-words font-medium text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CatalogSpecifications({
  facts,
  description,
  content,
  noteBlocks,
  copy,
  hasDescriptionImages = false,
}: {
  facts: CatalogProductDetail['facts'];
  description?: string;
  content?: CatalogContent;
  noteBlocks?: CatalogNoteBlocks;
  copy: SharedDetailContent;
  hasDescriptionImages?: boolean;
}) {
  const view = catalogContentView(facts, content);
  const notes = content
    ? view.notes
    : [
        ...(description || (hasDescriptionImages ? '' : copy.noDescription))
          .split(/\r?\n/)
          .map((p) => p.trim())
          .filter(Boolean),
        ...view.notes,
      ];
  return (
    <section className="mt-12 border-t border-slate-200" data-catalog-specifications>
      <details open className="border-b border-slate-200 py-6">
        <summary className="cursor-pointer font-display text-xl font-semibold text-ink focus-visible:outline-brand-700">
          {copy.specificationsLabel}
        </summary>
        {view.specifications.length ? (
          <>
            <p className="mt-3 max-w-[70ch] text-xs leading-5 text-ink-muted">
              {copy.specificationBasis}
            </p>
            <FactRows rows={view.specifications} />
          </>
        ) : (
          <p className="mt-4 text-sm text-ink-muted">{copy.noFacts}</p>
        )}
      </details>
      {view.packaging.length > 0 && (
        <section data-catalog-packaging className="border-b border-slate-200 py-6">
          <h2 className="font-display text-xl font-semibold text-ink">{copy.packagingLabel}</h2>
          <FactRows rows={view.packaging} />
        </section>
      )}
      {notes.length > 0 && (
        <details data-catalog-notes className="border-b border-slate-200 py-6">
          <summary className="cursor-pointer font-display text-xl font-semibold text-ink focus-visible:outline-brand-700">
            {content ? copy.supplierNotesLabel : copy.descriptionLabel}
          </summary>
          <div className="mt-5 max-w-[70ch] space-y-3 break-words text-sm leading-7 text-ink-soft">
            {noteBlocks ? (
              <>
                {noteBlocks.map((block, index) =>
                  block.kind === 'heading' ? (
                    <h3
                      key={`${index}:${block.text}`}
                      className="pt-4 font-display text-base font-semibold leading-6 text-ink"
                    >
                      {block.text}
                    </h3>
                  ) : (
                    <p key={`${index}:${block.text}`}>{block.text}</p>
                  ),
                )}
                {view.notes.slice(content?.notes.length ?? 0).map((text, index) => (
                  <p key={`${index}:${text}`}>{text}</p>
                ))}
              </>
            ) : (
              notes.map((paragraph, index) => <p key={`${index}:${paragraph}`}>{paragraph}</p>)
            )}
          </div>
        </details>
      )}
    </section>
  );
}
