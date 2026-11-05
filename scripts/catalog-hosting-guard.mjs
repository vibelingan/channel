/** Product HTML is guarded in the existing uploader's batches, through its real readback. */
export function guardCatalogHostingAdapters(api, delivery, paths) {
  const tickets = new Map();
  const key = (items) => JSON.stringify(items.map((e) => e.path));
  const begin = async (items) => {
    const relevant = items.filter(
      (e) =>
        e.path.endsWith('.html') ||
        /(?:^|\/)sitemap.*\.xml$/.test(e.path) ||
        e.path === 'seo-manifest.json' ||
        e.path === 'products/manifest.json',
    );
    if (!relevant.length) return;
    const products = [
      ...new Set(relevant.flatMap((e) => (paths.has(e.path) ? [paths.get(e.path)] : []))),
    ];
    const discovery = relevant.some((e) => !paths.has(e.path));
    const ticket = await delivery.begin(products, discovery);
    tickets.set(key(items), ticket);
  };
  const wrap = async (name, items, args, start, end) => {
    const fn = api[name];
    if (typeof fn !== 'function') throw Error('Missing hosting adapter method');
    if (start) await begin(items);
    const ticket = tickets.get(key(items));
    try {
      const value = await Reflect.apply(fn, api, args);
      if (end && ticket) {
        await delivery.end(ticket, 'verified');
        tickets.delete(key(items));
      }
      return value;
    } catch (error) {
      if (ticket) {
        await delivery.end(ticket, 'unknown');
        tickets.delete(key(items));
      }
      throw error;
    }
  };
  return {
    ...api,
    uploadBatch: (entries, ...rest) =>
      wrap('uploadBatch', entries, [entries, ...rest], true, false),
    verifyBatch: (entries, ...rest) =>
      wrap('verifyBatch', entries, [entries, ...rest], false, true),
    upload: (entry, ...rest) => wrap('upload', [entry], [entry, ...rest], true, false),
    verify: (entry, ...rest) => wrap('verify', [entry], [entry, ...rest], false, true),
    removeBatch: (items, ...rest) => {
      const entries = items.map((e) => (typeof e === 'string' ? { path: e } : e));
      return wrap('removeBatch', entries, [items, ...rest], true, true);
    },
    remove: (path, ...rest) => wrap('remove', [{ path }], [path, ...rest], true, true),
    accept: async (...args) => {
      await delivery.check();
      const fn = api.accept;
      if (typeof fn !== 'function') throw Error('Missing hosting acceptance');
      return Reflect.apply(fn, api, args);
    },
  };
}
