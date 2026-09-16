const requestPageSize = 100;
const maxSnapshotProducts = 1000;
const maxPages = 25;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {import('./public-catalog-snapshot.mjs').FetchPublicCatalogPage} fetchPage
 * @returns {Promise<string[]>}
 */
export async function publicCatalogSnapshot(fetchPage) {
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {number | undefined} */
  let expectedTotal;
  /** @type {number | undefined} */
  let expectedPageSize;

  for (let requestedPage = 1; requestedPage <= maxPages; requestedPage += 1) {
    const response = await fetchPage(requestedPage, requestPageSize);
    if (!response.ok()) throw new Error(`Public catalog HTTP failure on page ${requestedPage}.`);
    const body = await response.json();
    if (!isRecord(body) || body.ok !== true || !isRecord(body.data))
      throw new Error('Malformed public catalog response.');
    const { items, total, page, pageSize } = body.data;
    if (
      !Array.isArray(items) ||
      typeof total !== 'number' ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      typeof page !== 'number' ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      typeof pageSize !== 'number' ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > requestPageSize
    )
      throw new Error('Malformed public catalog pagination metadata.');
    if (page !== requestedPage) throw new Error('Unexpected public catalog page.');
    if (total > maxSnapshotProducts)
      throw new Error(
        `Public catalog exceeds the ${maxSnapshotProducts}-product snapshot read budget.`,
      );
    if (expectedTotal !== undefined && total !== expectedTotal)
      throw new Error('Public catalog total changed during pagination.');
    if (expectedPageSize !== undefined && pageSize !== expectedPageSize)
      throw new Error('Public catalog pageSize changed during pagination.');
    expectedTotal = total;
    expectedPageSize = pageSize;
    if (Math.ceil(total / pageSize) > maxPages)
      throw new Error(`Public catalog snapshot would exceed ${maxPages} pages.`);
    const expectedCount = Math.min(pageSize, total - ids.size);
    if (items.length > expectedCount) throw new Error('Excess public catalog records.');
    if (items.length < expectedCount) throw new Error('Incomplete public catalog page.');
    for (const item of items) {
      if (!isRecord(item) || typeof item._id !== 'string' || item._id.trim().length === 0)
        throw new Error('Malformed public catalog product ID.');
      if (ids.has(item._id)) throw new Error('Duplicate public catalog product ID.');
      ids.add(item._id);
    }
    if (ids.size === total) return [...ids].sort();
  }
  throw new Error(`Incomplete public catalog snapshot after ${maxPages} pages.`);
}
