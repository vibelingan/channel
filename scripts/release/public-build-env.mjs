const buildKeys = new Set([
  'PATH',
  'HOME',
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_SHA',
  'CHANNEL_BUILD_SHA',
  'NODE_ENV',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SITE_URL',
  'SEO_CATALOG_SNAPSHOT',
  'SEO_CATALOG_API_ORIGIN',
  'SEO_BLOG_SNAPSHOT',
  'SEO_BLOG_RELEASE_INPUT',
  'SEO_BLOG_TASK_ID',
]);
const allowed = (key) => buildKeys.has(key) || key.startsWith('PUBLIC_');
/** Frontend compilation and anonymous collectors need public settings, not the publisher's management or login credentials. */
export function publicBuildEnvironment(source, extra = {}) {
  for (const key of Object.keys(extra))
    if (!allowed(key)) throw Error('Private setting passed to a public build');
  return Object.freeze(
    Object.fromEntries(
      Object.entries({ ...source, ...extra }).filter(
        ([key, value]) => allowed(key) && typeof value === 'string',
      ),
    ),
  );
}
