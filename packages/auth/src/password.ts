import { randomBytes, randomInt } from 'node:crypto';
import { argon2Verify, argon2id } from 'hash-wasm';

const ARGON2ID_OPTIONS = {
  iterations: 3,
  parallelism: 1,
  memorySize: 19 * 1024,
  hashLength: 32,
} as const;

/** Hash a plaintext password using argon2id. */
export function hashPassword(plain: string): Promise<string> {
  return argon2id({
    password: plain,
    salt: randomBytes(16),
    outputType: 'encoded',
    ...ARGON2ID_OPTIONS,
  });
}

/** Verify a plaintext password against an argon2id hash. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: plain, hash });
  } catch {
    return false;
  }
}

// Ambiguous characters (0/O, 1/l/I) are excluded for legibility in emails.
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';

/** Generate a cryptographically-strong random password (default 12 chars). */
export function generateRandomPassword(length = 12): string {
  if (length < 8) throw new Error('generateRandomPassword: length must be >= 8');
  let pwd = '';
  for (let i = 0; i < length; i += 1) {
    pwd += PASSWORD_CHARS[randomInt(0, PASSWORD_CHARS.length)];
  }
  return pwd;
}
