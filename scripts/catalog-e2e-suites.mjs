const path = (name) => `tests/e2e/${name}.spec.ts`;
/** Each CI group owns a fresh local API, database and build; default all preserves the original order. */
export function catalogE2eSuites({ formal, group = 'all' }) {
  if (
    typeof formal !== 'boolean' ||
    !['all', 'storefront', 'admin', 'admin-workflows', 'taxonomy'].includes(group) ||
    (group === 'admin-workflows' && !formal)
  )
    throw Error('Unknown catalog browser group');
  const storefront = [
    ['public'],
    ['header-navigation', 'catalog-hub', 'catalog-family-routes', 'catalog-category', 'sku-detail'],
  ];
  const admin = [
    ...(formal
      ? [['catalog-formal-journey']]
      : [
          ['font-loading'],
          ['catalog-local-seed'],
          ['catalog-admin'],
          ['admin-product-form', 'admin-product-family-tabs'],
        ]),
    ['admin-subcategory-visibility'],
    ['admin-readiness-default'],
  ];
  const taxonomy = [['catalog-taxonomy']];
  const suites =
    group === 'all'
      ? [...storefront, ...admin, ...taxonomy]
      : {
          storefront,
          // Classification owns a fresh seed so its timing does not depend on the
          // earlier lifecycle fixture history.
          admin: formal ? [['admin-subcategory-visibility']] : admin,
          'admin-workflows': [['catalog-formal-journey'], ['admin-readiness-default']],
          taxonomy,
        }[group];
  return suites.map((suite) => suite.map(path));
}
