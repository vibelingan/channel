export interface PublicCatalogResponse {
  ok(): boolean;
  json(): Promise<unknown>;
}

export type FetchPublicCatalogPage = (
  page: number,
  requestedPageSize: number,
) => Promise<PublicCatalogResponse>;

export declare function publicCatalogSnapshot(fetchPage: FetchPublicCatalogPage): Promise<string[]>;
