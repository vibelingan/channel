/** Runtime contracts are checked independently; unrelated services need not share a Git SHA. */
export function assertBlogIndexingPreflight({ siteOrigin, admin, api, formal, temporary }) {
  const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  if (
    siteOrigin !== 'https://supplychainsai.com' ||
    !sha(admin?.releaseId) ||
    !sha(api?.releaseId) ||
    admin.articleDeliveryMode !== 'server' ||
    typeof admin.articlePublishingEnabled !== 'boolean' ||
    api.articlePublicReadEnabled !== true
  )
    throw Error('The current Blog API contracts were not confirmed');
  for (const value of [formal, temporary]) {
    if (
      value?.service !== 'blog-pages' ||
      value.status !== 'ok' ||
      value.siteOrigin !== siteOrigin ||
      !sha(value.releaseId) ||
      value.indexingPolicyVersion !== 1 ||
      typeof value.previewOnly !== 'boolean' ||
      value.indexing?.enabled !== !value.previewOnly
    )
      throw Error('Verified Blog host policy and running program required');
  }
  if (
    formal.releaseId !== temporary.releaseId ||
    formal.previewOnly !== temporary.previewOnly ||
    formal.indexing.canonicalHost !== true ||
    formal.indexing.allowed !== !formal.previewOnly ||
    temporary.indexing.canonicalHost !== false ||
    temporary.indexing.allowed !== false
  )
    throw Error('The formal and temporary Blog hosts are not safely distinguished');
  return { adminSha: admin.releaseId, apiSha: api.releaseId, blogSha: formal.releaseId };
}
