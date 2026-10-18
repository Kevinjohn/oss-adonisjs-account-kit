import { createHash } from 'node:crypto'

export const verifier = 'a'.repeat(43)
export const clientChallenge = createHash('sha256').update(verifier).digest('base64url')

/** Trusted deterministic adapter fixture; production Ally does not attest authentication time. */
export const provider = (subject: string, email: string | null, verified: boolean) => ({
  authorizationUrl: async (state: string) => `https://provider.test/start?state=${state}`,
  resolve: async () => ({ subject, email, emailVerified: verified }),
  verifyFreshAuthentication: async () => ({
    verified: true as const,
    subject,
    authenticatedAt: new Date().toISOString(),
  }),
})
