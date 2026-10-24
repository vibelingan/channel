/**
 * AES-256-GCM token envelope (ARCHITECTURE §8).
 *
 * Alibaba OAuth tokens are encrypted at rest with ALI_TOKEN_ENCRYPTION_KEY_V1
 * — exactly 64 lowercase hex characters (32 bytes). The `v1` version rides in
 * the envelope so a future _V2 rotation can decrypt old rows. Validation is
 * lazy (first use), never at module load: an unconfigured environment keeps
 * cold start and /health alive and surfaces `not_configured` instead
 * (public-api optional-JWT_SECRET precedent, R1 L7/L12).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface AlibabaTokenEnvelope {
  v: 'v1';
  iv: string;
  tag: string;
  data: string;
}

const KEY_HEX = /^[0-9a-f]{64}$/;
const IV_BYTES = 12;

/** Returns the 32-byte key, or null when the env value is absent/malformed. */
export function parseTokenEncryptionKey(hex: string | undefined): Buffer | null {
  if (!hex || !KEY_HEX.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

export function encryptTokenPayload(
  key: Buffer,
  payload: Record<string, unknown>,
): AlibabaTokenEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 'v1',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** Authenticated decryption; ANY failure (tamper, wrong key, shape) yields null. */
export function decryptTokenPayload(
  key: Buffer,
  envelope: unknown,
): Record<string, unknown> | null {
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    (envelope as AlibabaTokenEnvelope).v !== 'v1'
  ) {
    return null;
  }
  const { iv, tag, data } = envelope as AlibabaTokenEnvelope;
  if (typeof iv !== 'string' || typeof tag !== 'string' || typeof data !== 'string') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]);
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
