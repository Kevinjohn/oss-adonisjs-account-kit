import { test } from '@japa/runner'
import type { socialProviderCallbackValidator } from '#validators/social'
import { allySocialProvider, SocialProviderExchangeError } from '#services/social_provider'

test('Ally adapter uses request-scoped state and rejects a crossed callback path', async ({
  assert,
}) => {
  let passedState: string | undefined
  let userCalls = 0
  let statelessCalls = 0
  let statelessReady = false
  let failUser = false
  const driver = {
    stateless() {
      statelessCalls++
      statelessReady = true
      return this
    },
    async redirectUrl(configure: (request: { param(name: string, value: string): void }) => void) {
      if (!statelessReady) throw new Error('Ally redirect must be stateless')
      statelessReady = false
      configure({
        param(name, value) {
          if (name === 'state') passedState = value
        },
      })
      return `https://provider.example.test/?state=${passedState}`
    },
    async user() {
      if (!statelessReady) throw new Error('Ally callback must be stateless')
      statelessReady = false
      userCalls++
      if (failUser) throw new Error('private provider payload')
      return {
        id: 'Google-Subject',
        email: 'verified@example.test',
        emailVerificationState: 'verified' as const,
        token: { token: 'provider-secret' },
      }
    },
  }
  const requestFor = (body: Record<string, unknown>) => ({
    validateUsing: (validator: typeof socialProviderCallbackValidator) => validator.validate(body),
  })
  const provider = allySocialProvider('google')
  const rejectsCategory = async (callback: unknown, category: string) => {
    await assert.rejects(async () => {
      try {
        await provider.resolve(callback)
      } catch (error) {
        if (!(error instanceof SocialProviderExchangeError)) throw error
        assert.equal(error.category, category)
        throw error
      }
    }, SocialProviderExchangeError)
  }
  const context = {
    params: { provider: 'google' },
    request: requestFor({ code: 'provider-code' }),
    ally: {
      use(name: string) {
        assert.equal(name, 'google')
        return driver
      },
    },
  }
  const url = await provider.authorizationUrl('trusted-state', context)
  assert.equal(new URL(url).searchParams.get('state'), 'trusted-state')
  assert.equal(passedState, 'trusted-state')
  assert.equal(statelessCalls, 1)
  await rejectsCategory({ ...context, params: { provider: 'github' } }, 'provider_mismatch')
  await rejectsCategory({ ...context, request: requestFor({ error: 'access_denied' }) }, 'denied')
  await rejectsCategory({ ...context, request: requestFor({}) }, 'missing_code')
  assert.equal(userCalls, 0)
  const profile = await provider.resolve(context)
  assert.equal(userCalls, 1)
  assert.equal(statelessCalls, 2)
  assert.equal(profile.subject, 'Google-Subject')
  assert.isTrue(profile.emailVerified)
  assert.notProperty(profile, 'token')
  failUser = true
  await rejectsCategory(context, 'unavailable')
})
