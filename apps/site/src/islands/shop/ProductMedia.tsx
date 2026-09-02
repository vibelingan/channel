import { useEffect, useReducer, useRef, useState } from 'react';
import {
  advanceFailedMedia,
  catalogMediaSourceId,
  createCatalogMediaState,
} from '../../catalog/application/catalog-media.ts';
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
  return createCatalogMediaState(sources).sources.map(apiMediaUrl);
}

type CatalogMediaAction = { type: 'sourceFailed'; sourceId: string };

function catalogMediaReducer(
  state: ReturnType<typeof createCatalogMediaState>,
  action: CatalogMediaAction,
) {
  return action.type === 'sourceFailed' ? advanceFailedMedia(state, action.sourceId) : state;
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
  const [state, dispatch] = useReducer(catalogMediaReducer, sources, createCatalogMediaState);
  const [unavailableAnnouncement, setUnavailableAnnouncement] = useState('');
  const imageRef = useRef<HTMLImageElement | null>(null);
  const source = state.sources[state.activeIndex];

  useEffect(() => {
    setUnavailableAnnouncement(source === undefined && alt ? `${alt}. ${unavailableLabel}` : '');
  }, [alt, source, unavailableLabel]);

  // A server-rendered image can FAIL before hydration attaches onError, and
  // the browser does not replay the error event — without this check an SSR
  // hero/card whose first gated source 404s during page load would sit on a
  // broken image forever instead of advancing through the ordered fallback.
  const activeIndex = state.activeIndex;
  useEffect(() => {
    const image = imageRef.current;
    if (!image || source === undefined) return;
    if (image.complete && image.naturalWidth === 0) {
      dispatch({ type: 'sourceFailed', sourceId: catalogMediaSourceId(activeIndex, source) });
    }
  }, [activeIndex, source]);

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
          ref={imageRef}
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
            dispatch({
              type: 'sourceFailed',
              sourceId: catalogMediaSourceId(state.activeIndex, source),
            })
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
