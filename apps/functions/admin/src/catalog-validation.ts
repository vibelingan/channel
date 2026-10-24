/** Shared safe catalog diagnostics used by prepare and every approval stage. */
export {
  CatalogValidationReportSchema as CatalogValidationSchema,
  type CatalogValidationReport as CatalogValidation,
  catalogValidationFailure,
  catalogValidationMessage,
} from '@vibelingan-channel/shared/catalog-issues';
