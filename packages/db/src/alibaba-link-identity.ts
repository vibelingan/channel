/** Shared decoder for explicit Alibaba source ownership, excluding capture metadata. */
import { z } from 'zod';

const nonEmpty = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const LinkSchema = z
  .object({
    _id: nonEmpty,
    sourceKey: nonEmpty,
    connectionId: nonEmpty,
    sourceProductId: nonEmpty,
    productId: z.string(),
    linkedAt: nonEmpty,
  })
  .strip();
export type AlibabaProductLinkIdentity = z.infer<typeof LinkSchema>;

export function parseAlibabaProductLink(
  value: unknown,
  allowEmptyClaim = false,
): AlibabaProductLinkIdentity | null {
  const parsed = LinkSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data._id !== parsed.data.sourceKey ||
    (parsed.data.productId.trim() === '' && !(allowEmptyClaim && parsed.data.productId === ''))
  )
    return null;
  return parsed.data;
}
