import { SignJWT, jwtVerify } from 'jose';

export interface AdminClaims {
  sub: string;
  role: 'admin';
}

const ALG = 'HS256';
const ISSUER = 'channel-portal';
const AUDIENCE = 'channel-admin';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Sign an admin session token. `ttlSeconds` defaults to 12 hours. */
export function signAdminToken(
  secret: string,
  claims: AdminClaims,
  ttlSeconds = 60 * 60 * 12,
): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret));
}

/** Verify an admin session token. Returns the claims or null when invalid. */
export async function verifyAdminToken(secret: string, token: string): Promise<AdminClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.role !== 'admin' || typeof payload.sub !== 'string') return null;
    return { sub: payload.sub, role: 'admin' };
  } catch {
    return null;
  }
}
