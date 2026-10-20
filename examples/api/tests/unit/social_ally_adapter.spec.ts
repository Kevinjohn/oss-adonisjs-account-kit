import { test } from '@japa/runner'
import { allySocialProvider } from '#services/social_provider'

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
  const provider = allySocialProvider('google')
  const context = {
    params: { provider: 'google' },
    request: { input: (name: string) => (name === 'code' ? 'provider-code' : undefined) },
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
  await assert.rejects(() => provider.resolve({ ...context, params: { provider: 'github' } }))
  await assert.rejects(() =>
    provider.resolve({
      ...context,
      request: { input: (name: string) => (name === 'error' ? 'access_denied' : undefined) },
    })
  )
  await assert.rejects(() => provider.resolve({ ...context, request: { input: () => undefined } }))
  assert.equal(userCalls, 0)
  const profile = await provider.resolve(context)
  assert.equal(userCalls, 1)
  assert.equal(statelessCalls, 2)
  assert.equal(profile.subject, 'Google-Subject')
  assert.isTrue(profile.emailVerified)
  assert.notProperty(profile, 'token')
  failUser = true
  await assert.rejects(() => provider.resolve(context), 'Social provider exchange failed')
})
