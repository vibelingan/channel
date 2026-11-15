const path = (name) => `tests/e2e/${name}.spec.ts`;
/** Each CI group owns a fresh local API, database and build; default all preserves the original order. */
export function catalogE2eSuites({ formal, group = 'all' }) {
  if (
    typeof formal !== 'boolean' ||
    !['all', 'storefront', 'sku-detail', 'admin', 'admin-workflows', 'taxonomy'].includes(group) ||
    (group === 'admin-workflows' && !formal)
  )
    throw Error('Unknown catalog browser group');
  // These four pages only read and search; nothing they do changes what sku-detail sees.
  const catalogPages = [
    'header-navigation',
    'catalog-hub',
    'catalog-family-routes',
    'catalog-category',
  ];
  const storefront = [['public'], [...catalogPages, 'sku-detail']];
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
          // SKU detail is the longest storefront spec (~2.5 min); it gets its own fresh seed.
          storefront: [['public'], catalogPages],
          'sku-detail': [['sku-detail']],
          // Classification owns a fresh seed so its timing does not depend on the
          // earlier lifecycle fixture history.
          admin: formal ? [['admin-subcategory-visibility']] : admin,
          'admin-workflows': [['catalog-formal-journey'], ['admin-readiness-default']],
          taxonomy,
        }[group];
  return suites.map((suite) => suite.map(path));
}
