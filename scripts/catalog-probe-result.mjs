const checks = Object.freeze([
  'real-product-save-and-request-transaction',
  'repeat-consumption-does-not-duplicate',
  'public-change-advances-version',
  'real-database-aborts-product-and-queue-together',
  'known-failure-releases-only-owned-task',
  'real-transaction-blocks-save-during-delivery',
  'real-batched-page-availability-query',
  'withdrawal-invalidates-ready-page',
  'unknown-outcome-prevents-takeover',
  'real-approved-variant-pagination',
]);
/** Only our complete return value proves the synchronous invocation finished safely. */
export function readCatalogProbeResult(response, run) {
  if (
    !response ||
    typeof response !== 'object' ||
    typeof response.RequestId !== 'string' ||
    !response.RequestId ||
    typeof response.RetMsg !== 'string' ||
    response.RetMsg.length > 16384 ||
    (Object.hasOwn(response, 'InvokeFinished') && response.InvokeFinished !== 1) ||
    (Object.hasOwn(response, 'RetCode') && response.RetCode !== 0) ||
    (typeof response.ErrMsg === 'string' && response.ErrMsg.trim())
  )
    throw Error('Catalog probe invocation completion is unconfirmed');
  let result;
  try {
    result = JSON.parse(response.RetMsg);
  } catch {
    throw Error('Catalog probe returned invalid JSON');
  }
  if (
    !result ||
    result.purpose !== 'catalog-seo-live-probe-v1' ||
    result.environment !== 'diversity-123-d9grnqfux221323bb' ||
    result.prefix !== `seo_probe_${run}_` ||
    result.passed !== checks.length ||
    !Array.isArray(result.checks) ||
    result.checks.length !== checks.length ||
    new Set(result.checks).size !== checks.length ||
    checks.some((check) => !result.checks.includes(check)) ||
    result.businessCollectionsAccessed !== 0 ||
    result.websiteWrites !== 0 ||
    result.htmlDeliveryVerified !== false ||
    result.approvedVariantCount !== 137
  )
    throw Error('Catalog probe did not confirm every isolated check');
  return result;
}
