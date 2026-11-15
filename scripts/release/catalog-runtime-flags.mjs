const writers = ['admin', 'alibaba-catalog-sync'];
/** A normal release must not silently disable a website's existing change tracking. */
export function assertCatalogTrackingContinuity(active, config) {
  if (active?.catalogTracked === true && !config)
    throw Error(
      'Existing tracked product pages require CATALOG_SEO_RECORDING=1 and their site origin; normal publication cannot disable change tracking',
    );
}
/** Read only the managed flags; credentials in the returned SDK details never enter reports. */
export async function checkCatalogRuntimeFlags(manager, config, envId, deployment) {
  const results = [];
  for (const name of [...writers, 'public-api']) {
    const detail = await manager.functions.getFunctionDetail(name);
    if (
      detail.FunctionName !== name ||
      detail.Status !== 'Active' ||
      detail.Runtime !== 'Nodejs20.19' ||
      !Array.isArray(detail.Environment?.Variables)
    )
      throw Error('Catalog function configuration is not ready');
    const flag = (key) => {
      const values = detail.Environment.Variables.filter((v) => v.Key === key);
      if (values.length > 1) throw Error('Duplicate catalog function setting');
      return values[0]?.Value;
    };
    if (
      flag('TCB_ENV') !== envId ||
      (flag('CATALOG_DETAIL_APPROVAL_ENABLED') === '1') !== config.detailEnabled
    )
      throw Error(`${name}: public detail mode differs from the catalog builder`);
    if (
      writers.includes(name) &&
      (flag('CATALOG_SEO_RECORDING') !== '1' ||
        flag('CATALOG_SEO_SITE_ORIGIN') !== config.siteOrigin)
    )
      throw Error(`${name}: product change recording has not been enabled for this website`);
    if (
      name === 'public-api' &&
      config.requireReadiness &&
      (flag('CATALOG_SEO_PAGE_READINESS') !== '1' ||
        flag('CATALOG_SEO_SITE_ORIGIN') !== config.siteOrigin)
    )
      throw Error('public-api: existing product-page readiness has not been enabled');
    if (
      name === 'public-api' &&
      deployment &&
      flag('CATALOG_SEO_PAGE_READINESS') === '1' &&
      deployment.pageReadiness !== '1'
    )
      throw Error(
        'Existing tracked product pages: normal deployment cannot disable page readiness',
      );
    results.push({ name, detailEnabled: config.detailEnabled, recording: writers.includes(name) });
  }
  return results;
}

export function assertTrackedCatalogProgram(active, baseline) {
  if (
    active?.catalogTracked !== true ||
    active.acceptedRunId !== baseline?.sourceRunId ||
    !/^[a-f0-9]{40}$/.test(active.codeSha ?? '')
  )
    throw Error('Existing product pages have not finished tracked HTML acceptance');
}
