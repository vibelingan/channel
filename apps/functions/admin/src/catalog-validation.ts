import { z } from 'zod';

export const CatalogValidationSchema = z
  .object({
    stage: z.enum(['source-candidate', 'source-page', 'source-persistence']),
    issues: z.array(z.string().min(1).max(200)).min(1).max(5),
  })
  .strict();
export type CatalogValidation = z.infer<typeof CatalogValidationSchema>;

export function catalogValidationFailure(stage: CatalogValidation['stage'], issues: string[]) {
  return {
    ok: false as const,
    code: 'VALIDATION_ERROR' as const,
    validation: CatalogValidationSchema.parse({
      stage,
      issues: issues.slice(0, 5).map((issue) => issue.slice(0, 200)),
    }),
  };
}

export function catalogValidationMessage(input: unknown): string | undefined {
  const parsed = CatalogValidationSchema.safeParse(input);
  return parsed.success
    ? `Product detail data is invalid (${parsed.data.stage}): ${parsed.data.issues.join('; ')}`
    : undefined;
}
