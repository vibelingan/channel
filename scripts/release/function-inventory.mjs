const pageSize = 100;
const unproven = () => {
  throw Object.assign(Error('FUNCTION_INVENTORY_UNPROVEN'), {
    code: 'FUNCTION_INVENTORY_UNPROVEN',
  });
};

// listFunctions drops the response count and defaults a missing Functions field to [].
// Cleanup needs the raw getFunctionList response to prove that nothing was omitted.
// ListFunctions provides no pagination snapshot. More than one page needs a separate
// exact-absence contract before it can safely confirm that a worker was deleted.
export async function readCompleteFunctionInventory(functions, envId) {
  if (typeof functions?.getFunctionList !== 'function' || typeof envId !== 'string' || !envId)
    unproven();
  const names = new Set();
  const result = await functions.getFunctionList(pageSize, 0);
  if (
    typeof result?.RequestId !== 'string' ||
    !result.RequestId.trim() ||
    !Number.isSafeInteger(result.TotalCount) ||
    result.TotalCount < 0 ||
    result.TotalCount > pageSize ||
    !Array.isArray(result.Functions) ||
    result.Functions.length !== result.TotalCount
  )
    unproven();
  for (const row of result.Functions) {
    if (
      row?.Namespace !== envId ||
      typeof row.FunctionName !== 'string' ||
      !row.FunctionName.trim() ||
      names.has(row.FunctionName)
    )
      unproven();
    names.add(row.FunctionName);
  }
  return [...names];
}
