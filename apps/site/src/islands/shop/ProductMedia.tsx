import type { CatalogImagePresentation } from '@vibelingan-channel/shared/catalog-image-presentation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  advanceFailedMedia,
  catalogMediaSourceId,
  createCatalogMediaState,
} from '../../catalog/application/catalog-media.ts';
import {
  imageCandidateAttributes,
  responsiveImageCandidates,
  siteCatalogImagePath,
} from '../../catalog/presentation/responsive-images.ts';
import { apiMediaUrl } from '../../lib/api-url.ts';

export const CatalogHeroImageApiOrigin = createContext<string | undefined>(undefined);

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
  imagePresentation?: CatalogImagePresentation | undefined;
  sizes?: string;
  sources: readonly string[];
  alt: string;
  unavailableLabel?: string;
  className?: string;
  imageClassName?: string;
  width?: number;
  height?: number;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
  autoPriorityForSmallVariant?: boolean;
  onLoad?: () => void;
  preferSiteImage?: boolean;
  siteImageApiOrigin?: string | undefined;
}

export function createProductMediaState(): ProductMediaState {
  return { activeIndex: 0, failedSourceIndexes: [] };
}

export function productMediaKey(sources: readonly string[]): string {
  return JSON.stringify(sources);
}

export function productMediaImageKey(sourceIndex: number, source: string): string {
  return catalogMediaSourceId(sourceIndex, source);
}

export function productMediaReducer(
  state: ProductMediaState,
  action: ProductMediaAction,
): ProductMediaState {
  // Preserve the existing index-shaped component seam; the domain owns the failure rule.
  const media = {
    sources: action.sources,
    activeIndex: state.activeIndex,
    failedSourceIds: state.failedSourceIndexes.map((index) =>
      catalogMediaSourceId(index, action.sources[index] ?? ''),
    ),
  };
  const next = advanceFailedMedia(media, catalogMediaSourceId(action.sourceIndex, action.source));
  if (next === media) return state;
  return {
    activeIndex: next.activeIndex,
    failedSourceIndexes: [...state.failedSourceIndexes, action.sourceIndex],
  };
}

function normalizeSources(sources: readonly string[]): string[] {
  return [...createCatalogMediaState(sources, apiMediaUrl).sources];
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
  autoPriorityForSmallVariant = false,
  preferSiteImage = false,
  siteImageApiOrigin,
  onLoad,
  imagePresentation,
  sizes = '100vw',
}: ProductMediaProps) {
  const [state, dispatch] = useReducer(productMediaReducer, undefined, createProductMediaState);
  const [unavailableAnnouncement, setUnavailableAnnouncement] = useState('');
  const [failedResponsiveSources, setFailedResponsiveSources] = useState<string[]>([]);
  const [failedSiteSources, setFailedSiteSources] = useState<string[]>([]);
  const catalogApiOrigin = useContext(CatalogHeroImageApiOrigin);
  const apiOrigin = siteImageApiOrigin ?? catalogApiOrigin;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const source = sources[state.activeIndex];
  const siteSource =
    apiOrigin && source && preferSiteImage && !failedSiteSources.includes(source)
      ? siteCatalogImagePath(source, apiOrigin)
      : undefined;
  const renderedSource = siteSource ?? source;
  const candidates = responsiveImageCandidates(source, imagePresentation);
  const responsive = imageCandidateAttributes(
    candidates,
    sizes,
    siteSource && apiOrigin ? (url) => siteCatalogImagePath(url, apiOrigin) ?? url : undefined,
  );
  const useResponsive = !!responsive.srcSet && !failedResponsiveSources.includes(source ?? '');
  const renderedPriority =
    autoPriorityForSmallVariant &&
    useResponsive &&
    candidates?.some((candidate) => candidate.url.endsWith('?w=160'))
      ? 'auto'
      : fetchPriority;
  const activeIndex = state.activeIndex;
  const handleFailure = useCallback(() => {
    if (source === undefined) return;
    if (siteSource) {
      // Retry the same size through the existing public API host.
      setFailedSiteSources((previous) =>
        previous.includes(source) ? previous : [...previous, source],
      );
      return;
    }
    if (useResponsive) {
      // Retry this same photo once at its unchanged default URL before advancing.
      setFailedResponsiveSources((previous) =>
        previous.includes(source) ? previous : [...previous, source],
      );
      return;
    }
    dispatch({ type: 'sourceFailed', sourceIndex: activeIndex, source, sources });
  }, [activeIndex, siteSource, source, sources, useResponsive]);

  useEffect(() => {
    setUnavailableAnnouncement(source === undefined && alt ? `${alt}. ${unavailableLabel}` : '');
  }, [alt, source, unavailableLabel]);

  // A server-rendered image can FAIL before hydration attaches onError, and
  // the browser does not replay the error event — without this check an SSR
  // hero/card whose first gated source 404s during page load would sit on a
  // broken image forever instead of advancing through the ordered fallback.
  useEffect(() => {
    const image = imageRef.current;
    if (!image || source === undefined) return;
    if (image.complete && image.naturalWidth === 0) {
      handleFailure();
    }
  }, [handleFailure, source]);

  return (
    <>
      {alt ? (
        <output className="sr-only" aria-live="polite" aria-atomic="true">
          {unavailableAnnouncement}
        </output>
      ) : null}
      {renderedSource === undefined ? (
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
          key={productMediaImageKey(state.activeIndex, renderedSource)}
          ref={imageRef}
          data-product-media="image"
          src={renderedSource}
          {...(useResponsive ? responsive : {})}
          alt={alt}
          width={width}
          height={height}
          loading={loading}
          fetchPriority={renderedPriority}
          decoding="async"
          onLoad={onLoad}
          referrerPolicy="no-referrer"
          className={`h-full w-full object-contain ${imageClassName} ${className}`}
          onError={handleFailure}
        />
      )}
    </>
  );
}

export function ProductMedia(props: ProductMediaProps) {
  const sources = normalizeSources(props.sources);
  return <ProductMediaSession key={productMediaKey(sources)} {...props} sources={sources} />;
}
