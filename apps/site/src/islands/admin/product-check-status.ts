import {
  type CatalogReadiness,
  CatalogReadinessSchema,
} from '@vibelingan-channel/shared/catalog-preparation';
import type { ListArgs } from './api.ts';
import { productFamilyListArgs } from './product-family-tabs.ts';

export const PRODUCT_CHECK_LABELS: Record<CatalogReadiness, string> = {
  all: 'All check statuses',
  normal: 'Ready or published',
  issues: 'Data issues',
  preparing: 'Preparing',
  unchecked: 'Unchecked',
};
export function productCheckFromSearch(search: string): CatalogReadiness {
  const checked = CatalogReadinessSchema.safeParse(new URLSearchParams(search).get('checkStatus'));
  return checked.success ? checked.data : 'all';
}
export function productCheckSearch(search: string, scope: CatalogReadiness): string {
  const params = new URLSearchParams(search);
  if (scope === 'all') params.delete('checkStatus');
  else params.set('checkStatus', scope);
  const result = params.toString();
  return result ? `?${result}` : '';
}
export function productCheckListArgs(args: ListArgs, scope: CatalogReadiness): ListArgs {
  const { catalogReadiness: _old, ...rest } = args;
  return args.collection === 'products' ? { ...rest, catalogReadiness: scope } : rest;
}
export function productClassificationCountArgs(args: ListArgs, scope: CatalogReadiness): ListArgs {
  return productFamilyListArgs(
    productCheckListArgs({ ...args, page: 1, pageSize: 1 }, scope),
    'unclassified',
  );
}
export function productCheckPublishBlock(scope: CatalogReadiness): string | null {
  if (scope === 'issues') return 'Open Preview or Edit to fix these products before publishing.';
  if (scope === 'preparing') return 'Finish checking these products in Preview before publishing.';
  if (scope === 'unchecked') return 'Open Preview to check these products before publishing.';
  return null;
}
