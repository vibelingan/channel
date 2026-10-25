// This handler transforms only supplied dummy records. It has no database, network or SDK dependency.
export async function dummyMain(event, { purpose, version, codeSha }) {
  const { action, id, record, patch } = event ?? {};
  if (action === 'health') return { purpose, version, codeSha };
  if (typeof id !== 'string' || !/^seo-drill-[a-z0-9-]{1,64}$/.test(id))
    throw new Error('Only reserved dummy IDs are accepted');
  if (record && (record._id !== id || record.purpose !== purpose))
    throw new Error('Foreign dummy record');
  if (action === 'create') {
    if (record || typeof event.label !== 'string' || !event.label || event.label.length > 200)
      throw new Error('Invalid dummy create');
    return {
      record: {
        _id: id,
        purpose,
        label: event.label,
        revision: 1,
        deleted: false,
        ...(version === 'B' && typeof event.note === 'string' ? { note: event.note } : {}),
      },
    };
  }
  if (!record) throw new Error('Dummy record not found');
  if (action === 'read') return { record: { ...record } };
  if (action === 'delete')
    return { record: { ...record, deleted: true, revision: record.revision + 1 } };
  if (action !== 'update' || record.deleted || !patch || Array.isArray(patch))
    throw new Error('Invalid dummy update');
  const allowed = version === 'B' ? ['label', 'note'] : ['label'];
  if (
    !Object.keys(patch).length ||
    Object.keys(patch).some(
      (key) => !allowed.includes(key) || typeof patch[key] !== 'string' || patch[key].length > 200,
    )
  )
    throw new Error('Invalid dummy patch');
  return { record: { ...record, ...patch, revision: record.revision + 1 } };
}
