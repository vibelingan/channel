/** Fixed repository permissions and a loopback-only return address for GitHub's manifest flow. */
export function catalogGithubAppManifest(origin) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin))
    throw Error('Local setup origin required');
  return {
    name: 'Channel Catalog HTML Delivery',
    url: 'https://github.com/vibelingan/channel',
    redirect_url: `${origin}/callback`,
    public: false,
    // GitHub requires a URL even with delivery disabled. No webhook events are subscribed.
    hook_attributes: { active: false, url: 'https://github.com/vibelingan/channel' },
    default_permissions: { actions: 'write', contents: 'read' },
    default_events: [],
  };
}
