/** Outside a transaction, node-sdk doc.get() returns data: []; transaction reads differ. */
export async function readDummyFixtures(db, runId) {
  if (!/^[1-9][0-9]{0,19}$/.test(runId)) throw Error('Exact dummy owner required');
  const rows = [];
  for (const suffix of ['existing', 'new-b', 'deleted-b']) {
    const id = `seo-drill-${runId}-${suffix}`;
    const response = await db.collection('seoReleaseDrillFixtures').doc(id).get();
    if (
      response?.code ||
      !response ||
      !Object.hasOwn(response, 'data') ||
      !Array.isArray(response.data) ||
      response.data.length > 1
    )
      throw Error('Actual dummy data read unconfirmed');
    const row = response.data[0];
    if (row && (row._id !== id || row.purpose !== 'channel-recovery-dummy-v1'))
      throw Error('Foreign dummy record');
    if (row) rows.push(row);
  }
  return rows;
}
