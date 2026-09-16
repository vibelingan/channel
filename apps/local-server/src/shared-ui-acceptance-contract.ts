import { z } from 'zod';

// Only test-process IPC and the fields asserted by browser acceptance. Keep this
// module independent of service imports and their process-global adapter wiring.
export const acceptanceReady = z.object({
  apiUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),
  credentials: z.object({
    email: z.literal('rfq-admin@channel.local'),
    password: z.string().min(24),
  }),
  file: z.string().endsWith('/db.json'),
});
export const acceptanceReadback = z.object({
  catalogQuoteRequests: z
    .array(
      z.object({
        _id: z.string(),
        status: z.string(),
        version: z.number().int(),
        notification: z.string(),
        target: z.unknown(),
        fields: z.unknown(),
        snapshot: z.unknown(),
        events: z.array(z.unknown()),
      }),
    )
    .default([]),
});
