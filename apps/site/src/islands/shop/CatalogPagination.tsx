import { Fragment, type ReactNode } from 'react';
import { isPlainProductClick } from '../../lib/seo/product-identity.ts';
import { CATALOG_PAGE_SIZE, catalogPageNumbers } from './numbered-catalog-state.ts';

export type NativePageNavigation = boolean | ((page: number) => boolean);

interface Props {
  page: number;
  total: number;
  pending: boolean;
  onPageChange: (page: number) => void;
  pageHref?: (page: number) => string;
  nativeNavigation?: NativePageNavigation;
}

const buttonClass =
  'min-h-11 min-w-11 border border-brand-300 bg-white px-3 py-2 text-sm font-semibold text-brand-700 disabled:opacity-60 aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700';

function PageControl({
  label,
  page,
  current,
  disabled,
  children,
  pageHref,
  nativeNavigation,
  onPageChange,
}: Pick<Props, 'pageHref' | 'nativeNavigation' | 'onPageChange'> & {
  label: string;
  page: number;
  current?: boolean;
  disabled: boolean;
  children: ReactNode;
}) {
  const className = `${buttonClass} ${current ? 'border-brand-700 bg-brand-50' : 'hover:bg-brand-50'}`;
  if (pageHref) {
    if (disabled)
      return (
        <span
          aria-label={label}
          aria-current={current ? 'page' : undefined}
          aria-disabled="true"
          className={className}
        >
          {children}
        </span>
      );
    return (
      <a
        href={pageHref(page)}
        aria-label={label}
        className={className}
        onClick={(event) => {
          const native =
            typeof nativeNavigation === 'function' ? nativeNavigation(page) : nativeNavigation;
          if (!native && isPlainProductClick(event)) {
            event.preventDefault();
            onPageChange(page);
          }
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      disabled={disabled}
      className={className}
      onClick={() => onPageChange(page)}
    >
      {children}
    </button>
  );
}

export function CatalogPagination({
  page,
  total,
  pending,
  onPageChange,
  pageHref,
  nativeNavigation,
}: Props) {
  const lastPage = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
  const pages = catalogPageNumbers(page, total);
  const controls = { onPageChange, pageHref, nativeNavigation };
  return (
    <nav
      aria-label="Pagination"
      aria-busy={pending || undefined}
      className="mt-8 flex flex-wrap items-center justify-center gap-2"
    >
      <PageControl
        {...controls}
        label="Previous page"
        page={page - 1}
        disabled={pending || page === 1}
      >
        <span aria-hidden="true">&lsaquo;</span>
      </PageControl>
      {pages.map((candidate, index) => (
        <Fragment key={candidate}>
          {index > 0 && candidate - (pages[index - 1] ?? candidate) > 1 && (
            <span aria-hidden="true" className="px-1 text-ink-muted">
              &hellip;
            </span>
          )}
          <PageControl
            {...controls}
            label={`Page ${candidate}`}
            page={candidate}
            current={candidate === page}
            disabled={pending || candidate === page}
          >
            {candidate}
          </PageControl>
        </Fragment>
      ))}
      <PageControl
        {...controls}
        label="Next page"
        page={page + 1}
        disabled={pending || page === lastPage}
      >
        <span aria-hidden="true">&rsaquo;</span>
      </PageControl>
    </nav>
  );
}
