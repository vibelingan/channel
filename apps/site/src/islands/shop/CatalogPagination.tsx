import { Fragment } from 'react';
import { CATALOG_PAGE_SIZE, catalogPageNumbers } from './numbered-catalog-state.ts';

interface Props {
  page: number;
  total: number;
  pending: boolean;
  onPageChange: (page: number) => void;
}

const buttonClass =
  'min-h-11 min-w-11 border border-brand-300 bg-white px-3 py-2 text-sm font-semibold text-brand-700 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700';

export function CatalogPagination({ page, total, pending, onPageChange }: Props) {
  const lastPage = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
  const pages = catalogPageNumbers(page, total);
  return (
    <nav
      aria-label="Pagination"
      aria-busy={pending || undefined}
      className="mt-8 flex flex-wrap items-center justify-center gap-2"
    >
      <button
        type="button"
        aria-label="Previous page"
        title="Previous page"
        disabled={pending || page === 1}
        onClick={() => onPageChange(page - 1)}
        className={buttonClass}
      >
        <span aria-hidden="true">&lsaquo;</span>
      </button>
      {pages.map((candidate, index) => (
        <Fragment key={candidate}>
          {index > 0 && candidate - (pages[index - 1] ?? candidate) > 1 && (
            <span aria-hidden="true" className="px-1 text-ink-muted">
              &hellip;
            </span>
          )}
          <button
            type="button"
            aria-label={`Page ${candidate}`}
            aria-current={candidate === page ? 'page' : undefined}
            disabled={pending || candidate === page}
            onClick={() => onPageChange(candidate)}
            className={`${buttonClass} ${candidate === page ? 'border-brand-700 bg-brand-50' : 'hover:bg-brand-50'}`}
          >
            {candidate}
          </button>
        </Fragment>
      ))}
      <button
        type="button"
        aria-label="Next page"
        title="Next page"
        disabled={pending || page === lastPage}
        onClick={() => onPageChange(page + 1)}
        className={buttonClass}
      >
        <span aria-hidden="true">&rsaquo;</span>
      </button>
    </nav>
  );
}
