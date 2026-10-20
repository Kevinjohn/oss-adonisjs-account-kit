/** Server-held PKCE verifiers for session guards, with the SHA-256 challenge sent to the kit. */
import { createHash, randomBytes } from 'node:crypto'

export function newVerifier(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
