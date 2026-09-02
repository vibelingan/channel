export interface CatalogMediaState {
  sources: readonly string[];
  activeIndex: number;
  failedSourceIds: readonly string[];
}

export function catalogMediaSourceId(sourceIndex: number, source: string): string {
  return `${sourceIndex}:${source}`;
}

export function createCatalogMediaState(
  sources: readonly string[],
  mapSource: (source: string) => string = (source) => source,
): CatalogMediaState {
  const uniqueSources: string[] = [];
  const seen = new Set<string>();
  for (const candidate of sources) {
    const source = mapSource(candidate.trim()).trim();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    uniqueSources.push(source);
    if (uniqueSources.length === 9) break;
  }
  return { sources: uniqueSources, activeIndex: 0, failedSourceIds: [] };
}

export function advanceFailedMedia(state: CatalogMediaState, sourceId: string): CatalogMediaState {
  const activeSource = state.sources[state.activeIndex];
  if (
    activeSource === undefined ||
    catalogMediaSourceId(state.activeIndex, activeSource) !== sourceId ||
    state.failedSourceIds.includes(sourceId)
  ) {
    return state;
  }
  return {
    ...state,
    activeIndex: state.activeIndex + 1,
    failedSourceIds: [...state.failedSourceIds, sourceId],
  };
}
