import { type Role, toRole } from '@vibelingan-channel/shared';
import { SignJWT, jwtVerify } from 'jose';

/** Claims carried inside a portal session token. */
export interface SessionClaims {
  /** User document id. */
  sub: string;
  email: string;
  /** Username (display name). */
  name: string;
  /** Role is embedded so authorization needs no per-request DB lookup. */
  role: Role;
}

const ALG = 'HS256';
const ISSUER = 'channel-portal';
const AUDIENCE = 'channel-session';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Sign a portal session token. `ttlSeconds` defaults to 12 hours. */
export function signSession(
  secret: string,
  claims: SessionClaims,
  ttlSeconds = 60 * 60 * 12,
): Promise<string> {
  return new SignJWT({ email: claims.email, name: claims.name, role: claims.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret));
}

/** Verify a portal session token. Returns the claims or null when invalid. */
export async function verifySession(secret: string, token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    });
    if (typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      name: typeof payload.name === 'string' ? payload.name : '',
      role: toRole(payload.role),
    };
  } catch {
    return null;
  }
}
