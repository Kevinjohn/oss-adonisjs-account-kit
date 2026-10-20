import type { HttpContext } from '@adonisjs/core/http'
import type { SocialProvider, SocialProviderName } from 'adonisjs-account-kit'

export interface SocialFixtureUser {
  subject: string
  email: string | null
  emailVerified: boolean
  name?: string | null
}

const fixtures = new Map<
  string,
  { provider: SocialProviderName; code: string; user: SocialFixtureUser }
>()

/** A deterministic provider exchange used only by the installed-consumer HTTP suite. */
export function setSocialFixture(
  state: string,
  provider: SocialProviderName,
  code: string,
  user: SocialFixtureUser
) {
  fixtures.set(state, { provider, code, user })
}

export function fixtureProvider(provider: SocialProviderName): SocialProvider {
  return {
    async authorizationUrl(state) {
      return `https://provider.example.test/authorize?state=${encodeURIComponent(state)}`
    },
    async resolve(callback) {
      const { request } = callback as HttpContext
      const state = request.input('state')
      const code = request.input('code')
      const fixture = fixtures.get(state)
      if (
        !fixture ||
        fixture.provider !== provider ||
        fixture.code !== code ||
        (callback as HttpContext).params.provider !== provider
      ) {
        throw new Error('Provider exchange failed')
      }
      fixtures.delete(state)
      return fixture.user
    },
  }
}
