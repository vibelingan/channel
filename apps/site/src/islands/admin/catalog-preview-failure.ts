import { type CatalogIssue, catalogFailureIssue } from '@vibelingan-channel/shared/catalog-issues';
import { AdminApiError } from './api.ts';

export interface CatalogPreviewFailure {
  message: string;
  issues: readonly CatalogIssue[];
}
export function catalogPreviewFailure(cause: unknown): CatalogPreviewFailure {
  if (cause instanceof AdminApiError)
    return {
      message: cause.message,
      issues: cause.isUnauthorized ? [catalogFailureIssue('UNAUTHORIZED')] : cause.issues,
    };
  return {
    message:
      'Product preview could not be loaded. Retry the preview or open the item to repair it.',
    issues: [],
  };
}
