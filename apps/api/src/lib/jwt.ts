import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

/**
 * JWT signing and verification, backed by `jose`.
 *
 * WHAT A JWT IS (worth keeping in the file, because it's the most
 * misunderstood thing about them):
 *
 *     eyJhbGciOiJIUzI1NiJ9 . eyJzdWIiOiIxMjMifQ . 4fJ0k...
 *     ^ header               ^ payload           ^ signature
 *
 * The first two segments are base64url-encoded JSON — NOT encrypted. Anyone
 * holding the token can read them; paste one into jwt.io and your user id is
 * right there. A JWT gives you INTEGRITY (nobody can alter the payload without
 * invalidating the signature), never CONFIDENTIALITY. So: a user id in the
 * payload is fine, a password or API key never is.
 *
 * WHY A LIBRARY: this was originally hand-written to understand the mechanics,
 * and that served its purpose. But hand-rolled crypto is the wrong thing to
 * ship — the failure modes (timing attacks, algorithm confusion, subtle base64
 * handling) are exactly the ones a well-audited library has already closed.
 * `jose` over `jsonwebtoken`: zero dependencies, ESM-native, and it ships its
 * own types.
 *
 * Everything below stays behind this module's own small API, so the routes and
 * middleware never import `jose` directly — which is precisely why swapping the
 * implementation touched only this file.
 */

const ALGORITHM = 'HS256';

export interface JwtPayload {
  /** "subject" — the user id. Standard claim name. */
  sub: string;
  /** "issued at", Unix SECONDS (the spec says seconds, not milliseconds). */
  iat: number;
  /** "expires at", Unix seconds. */
  exp: number;
}

/** HMAC keys are raw bytes, so the secret string has to be encoded first. */
function toKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export class JwtError extends Error {}

export async function createToken(
  userId: string,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(toKey(secret));
}

export async function verifyToken(token: string, secret: string): Promise<JwtPayload> {
  try {
    const { payload } = await jwtVerify(token, toKey(secret), {
      // Pinning the allowed algorithm is what defeats the classic `alg: none`
      // attack — a forged header claiming no algorithm, which a verifier that
      // trusts the header would honour by skipping the signature check.
      // jose requires this allowlist rather than trusting the token's header.
      algorithms: [ALGORITHM],
    });

    const { sub, iat, exp } = payload;
    if (typeof sub !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') {
      throw new JwtError('malformed payload');
    }

    return { sub, iat, exp };
  } catch (err) {
    if (err instanceof JwtError) throw err;

    // Collapse jose's error taxonomy (JWTExpired, JWSSignatureVerificationFailed,
    // JWSInvalid…) into one error type. Callers must NOT distinguish them: telling
    // a client "expired" vs "bad signature" tells an attacker which half of their
    // guess was right. Keeping that decision here means no call site can leak it
    // by accident.
    if (err instanceof joseErrors.JOSEError) throw new JwtError('invalid token');
    throw err;
  }
}
