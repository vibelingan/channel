import { useEffect, useReducer, useState } from 'react';
import { apiMediaUrl } from '../../lib/api-url.ts';

export interface ProductMediaState {
  activeIndex: number;
  failedSourceIndexes: readonly number[];
}

export type ProductMediaAction = {
  type: 'sourceFailed';
  sourceIndex: number;
  source: string;
  sources: readonly string[];
};

export interface ProductMediaProps {
  sources: readonly string[];
  alt: string;
  unavailableLabel?: string;
  className?: string;
  imageClassName?: string;
  width?: number;
  height?: number;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
}

export function createProductMediaState(): ProductMediaState {
  return { activeIndex: 0, failedSourceIndexes: [] };
}

export function productMediaKey(sources: readonly string[]): string {
  return JSON.stringify(sources);
}

export function productMediaImageKey(sourceIndex: number, source: string): string {
  return `${sourceIndex}:${source}`;
}

export function productMediaReducer(
  state: ProductMediaState,
  action: ProductMediaAction,
): ProductMediaState {
  const activeSource = action.sources[state.activeIndex];
  if (
    activeSource === undefined ||
    state.activeIndex !== action.sourceIndex ||
    activeSource !== action.source ||
    state.failedSourceIndexes.includes(action.sourceIndex)
  ) {
    return state;
  }

  return {
    activeIndex: state.activeIndex + 1,
    failedSourceIndexes: [...state.failedSourceIndexes, action.sourceIndex],
  };
}

function normalizeSources(sources: readonly string[]): string[] {
  return sources
    .map((source) => source.trim())
    .filter(Boolean)
    .map(apiMediaUrl);
}

function ProductMediaSession({
  sources,
  alt,
  unavailableLabel = 'Product image unavailable',
  className = '',
  imageClassName = '',
  width = 800,
  height = 800,
  loading = 'lazy',
  fetchPriority = 'auto',
}: ProductMediaProps) {
  const [state, dispatch] = useReducer(productMediaReducer, undefined, createProductMediaState);
  const [unavailableAnnouncement, setUnavailableAnnouncement] = useState('');
  const source = sources[state.activeIndex];

  useEffect(() => {
    setUnavailableAnnouncement(source === undefined && alt ? `${alt}. ${unavailableLabel}` : '');
  }, [alt, source, unavailableLabel]);

  return (
    <>
      {alt ? (
        <output className="sr-only" aria-live="polite" aria-atomic="true">
          {unavailableAnnouncement}
        </output>
      ) : null}
      {source === undefined ? (
        <div
          data-product-media="fallback"
          className={`flex aspect-square h-full w-full flex-col items-center justify-center bg-surface-alt px-4 text-center text-ink-muted ${className}`}
          aria-hidden="true"
        >
          <span className="font-display text-sm font-semibold uppercase tracking-[0.15em] text-brand-700">
            Channel
          </span>
          <span className="mt-2 text-xs">{unavailableLabel}</span>
        </div>
      ) : (
        <img
          key={productMediaImageKey(state.activeIndex, source)}
          data-product-media="image"
          src={source}
          alt={alt}
          width={width}
          height={height}
          loading={loading}
          fetchPriority={fetchPriority}
          decoding="async"
          className={`h-full w-full object-contain ${imageClassName} ${className}`}
          onError={() =>
            dispatch({ type: 'sourceFailed', sourceIndex: state.activeIndex, source, sources })
          }
        />
      )}
    </>
  );
}

export function ProductMedia(props: ProductMediaProps) {
  const sources = normalizeSources(props.sources);
  return <ProductMediaSession key={productMediaKey(sources)} {...props} sources={sources} />;
}
