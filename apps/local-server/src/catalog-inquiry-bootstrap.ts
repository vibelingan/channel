import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from '@vibelingan-channel/auth/password';
import type { AdminConfig } from '@vibelingan-channel/fn-admin/handler';
import { z } from 'zod';
import type { JsonFileAdapter } from './json-adapter.ts';

const credentialSchema = z
  .object({
    id: z.string().uuid(),
    email: z.literal('rfq-admin@channel.local'),
    password: z.string().min(24),
    jwtSecret: z.string().min(64),
  })
  .strict();
/** Only the explicitly opted-in loopback CLI calls this. No generic demo seed,
 * account overwrite, cloud credential lookup or automatic password reset. */
export async function bootstrapLocalInquiryAdmin(
  db: JsonFileAdapter,
  directory: string,
): Promise<AdminConfig> {
  const file = join(directory, 'local-admin.json');
  if (!existsSync(file)) {
    writeFileSync(
      file,
      JSON.stringify(
        {
          id: randomUUID(),
          email: 'rfq-admin@channel.local',
          password: randomBytes(24).toString('base64url'),
          jwtSecret: randomBytes(48).toString('hex'),
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
  }
  chmodSync(file, 0o600);
  const credentials = credentialSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const user = await db.findByField('users', 'email', credentials.email);
  if (user && (user._id !== credentials.id || user.localInquiryAdmin !== true))
    throw new Error(
      'Local inquiry admin conflicts with an existing account; no account was changed.',
    );
  if (!user)
    await db.create('users', {
      _id: credentials.id,
      email: credentials.email,
      username: 'Local RFQ Admin',
      role: 'admin',
      status: 'active',
      localInquiryAdmin: true,
      passwordHash: await hashPassword(credentials.password),
      loginCount: 0,
    });
  return { jwtSecret: credentials.jwtSecret, loginUrl: 'http://127.0.0.1:4328/login' };
}
