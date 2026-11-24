/** Server-held PKCE verifiers for session guards, with the SHA-256 challenge sent to the kit. */
import { randomBytes } from 'node:crypto'
import { deriveClientChallenge } from '../client_challenge.js'

export function generateVerifierAndChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: deriveClientChallenge(verifier) }
}
