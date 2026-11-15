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

// CloudBase can list a deleted function for longer than a few seconds, and can refuse
// DeleteFunction (FailedOperation.DeleteFunction) for 40-60 s after the function last ran
// (run 42968456325: four refusals, the fifth accepted at ~58 s). Checks back off from
// 250 ms to 5 s, about two minutes in all, before an absence is called unconfirmed.
export const FUNCTION_ABSENCE_CHECKS = 28;
export const functionAbsenceDelayMs = (check) => Math.min(250 * 2 ** (check - 1), 5000);

// SDK deleteFunction makes two remote calls (gateway bindings, then DeleteFunction); either
// can fail or be refused, and a failed attempt deletes nothing, so waiting alone cannot
// succeed. While the name is still listed the delete is sent again every second check, but
// never on the last checks, so an accepted delete always has time to show.
const DELETE_RETRY_EVERY = 2;
const LAST_RETRY_CHECK = FUNCTION_ABSENCE_CHECKS - 4;
const safeErrorCode = (error) => {
  const code = error?.code ?? error?.name;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,80}$/.test(code) ? code : 'error';
};

/**
 * Deletes an exact, already-verified function and waits for a complete inventory to omit
 * it. Returns how many deletes were sent and their error codes; never error messages.
 */
export async function deleteFunctionUntilAbsent({ remove, inventory, name, wait }) {
  const errors = [];
  let attempts = 0;
  const attempt = async () => {
    attempts++;
    try {
      await remove(name);
    } catch (error) {
      errors.push(safeErrorCode(error));
    }
  };
  await attempt();
  for (let check = 0; check < FUNCTION_ABSENCE_CHECKS; check++) {
    if (check) await wait(functionAbsenceDelayMs(check));
    if (!(await inventory()).includes(name)) return { absent: true, attempts, errors };
    if (check <= LAST_RETRY_CHECK && check % DELETE_RETRY_EVERY === DELETE_RETRY_EVERY - 1)
      await attempt();
  }
  return { absent: false, attempts, errors };
}
