const identity = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export function readArticleLocation(search: string): string | null {
  const query = new URLSearchParams(search);
  if (
    query.getAll('section').length !== 1 ||
    query.get('section') !== 'articles' ||
    query.getAll('article').length !== 1
  )
    return null;
  const id = query.get('article');
  return id && identity.test(id) ? id : null;
}
export function articleLocationPath(id: string | null): string {
  if (id !== null && !identity.test(id)) throw Error('Invalid article link');
  const query = new URLSearchParams({ section: 'articles' });
  if (id) query.set('article', id);
  return `/admin/?${query}`;
}
