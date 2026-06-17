import { randomInt } from 'node:crypto';
import argon2 from 'argon2';

/** Hash a plaintext password using argon2id. */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/** Verify a plaintext password against an argon2id hash. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
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
