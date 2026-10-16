import type { SocialProvider } from './types.js'

/**
 * Adapt one request-scoped Ally driver without importing Ally into service-only consumers.
 * The application owns the redirect response and returns its Location URL. Each initiation
 * and callback uses an Ally provider scoped to its own incoming request. Stateless mode lets
 * the package's one-use transaction state replace Ally's cookie state.
 */
export function createAllySocialProvider(input: {
  authorizationUrl(state: string, context?: unknown): Promise<string> | string
  user(callback: unknown): Promise<{
    id: string | number
    email: string | null
    emailVerificationState: 'verified' | 'unverified' | 'unsupported'
    name?: string | null
    nickName?: string | null
    avatarUrl?: string | null
    token?: unknown
    original?: unknown
  }>
}): SocialProvider {
  return {
    authorizationUrl: async (state, context) => input.authorizationUrl(state, context),
    async resolve(callback) {
      const user = await input.user(callback)
      return {
        subject: String(user.id),
        email: user.email,
        emailVerified: user.emailVerificationState === 'verified',
        name: user.name ?? null,
        nickname: user.nickName ?? null,
        avatarUrl: user.avatarUrl ?? null,
      }
    },
    // Ally's normalized user profile does not attest a new provider authentication event.
    // Reauthentication remains unsupported until an adapter verifies separate bound evidence.
  }
}
