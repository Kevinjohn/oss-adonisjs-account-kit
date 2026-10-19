// PKCE S256 helpers: checking challenge and verifier shapes and matching a verifier to its challenge.
import { createHash, timingSafeEqual } from 'node:crypto'

/** A PKCE S256 challenge: base64url SHA-256, 43 characters. */
export function isClientChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

/** A PKCE verifier: 43 to 128 unreserved characters. */
export function isClientVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value)
}

/** The challenge a client sends for `verifier`. */
export function clientChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function verifierMatches(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(challenge)
  const actual = Buffer.from(clientChallengeFor(verifier))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
