import { type APIRequestContext, expect } from '@playwright/test';
import { adminAction } from './admin-api';

/** Read the native snapshot, including committed proofs that have not been settled. */
export async function readImageReferenceCount(
  request: APIRequestContext,
  imageId: string,
  token: string,
): Promise<number> {
  const reference = await adminAction<{ imageId: string; state: string; count: number }>(
    request,
    'getImageReferenceCount',
    { imageId },
    token,
  );
  expect(reference.imageId).toBe(imageId);
  expect(reference.state).toBe('counted');
  expect(Number.isSafeInteger(reference.count)).toBe(true);
  expect(reference.count).toBeGreaterThanOrEqual(0);
  return reference.count;
}
