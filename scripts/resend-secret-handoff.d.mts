import type { KeyLike } from 'node:crypto';
export interface SecretPayload {
  purpose: 'RESEND_API_KEY' | 'RESEND_WEBHOOK_SECRET';
  secret: string;
}
export interface EncryptedHandoff {
  version: 1;
  key: string;
  iv: string;
  data: string;
}
export function decryptHandoff(bundle: unknown, privateKey: KeyLike): SecretPayload;
export function handoffPage(publicKey: string): string;
export function encryptTestPayload(payload: SecretPayload, publicKey: KeyLike): EncryptedHandoff;
