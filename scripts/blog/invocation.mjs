export function readBlogInvocation(value) {
  const raw = value?.data?.invokeResult;
  if (!raw || raw.InvokeResult !== 0 || typeof raw.RetMsg !== 'string')
    throw new Error('Cloud function invocation was not confirmed');
  const result = JSON.parse(raw.RetMsg);
  if (!result || typeof result.ok !== 'boolean')
    throw new Error('Cloud function returned no API envelope');
  return result;
}
