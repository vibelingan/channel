export interface CatalogMediaState {
  sources: readonly string[];
  activeIndex: number;
  failedSourceIds: readonly string[];
}

export function catalogMediaSourceId(sourceIndex: number, source: string): string {
  return `${sourceIndex}:${source}`;
}

export function createCatalogMediaState(_sources: readonly string[]): CatalogMediaState {
  throw new Error('MIU 12 catalog media state not implemented');
}

export function advanceFailedMedia(
  _state: CatalogMediaState,
  _sourceId: string,
): CatalogMediaState {
  throw new Error('MIU 12 catalog media state not implemented');
}
