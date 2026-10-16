import { test } from '@japa/runner'
import { createAllySocialProvider } from '../index.js'

test.group('Ally social provider mapping', () => {
  for (const state of ['verified', 'unverified', 'unsupported'] as const) {
    test(`maps Ally ${state} email state without retaining provider credentials`, async ({
      assert,
    }) => {
      const adapter = createAllySocialProvider({
        authorizationUrl: (nonce, context) =>
          `https://provider.test/start?state=${nonce}&context=${context}`,
        user: async () => ({
          id: 123,
          email: 'person@example.test',
          emailVerificationState: state,
          name: 'Person',
          nickName: 'person',
          avatarUrl: 'https://provider.test/avatar',
          token: { token: 'secret', refreshToken: 'refresh-secret' },
          original: { private: 'provider-data' },
        }),
      })
      assert.equal(
        await adapter.authorizationUrl('state', 'request'),
        'https://provider.test/start?state=state&context=request'
      )
      const profile = await adapter.resolve({})
      assert.isUndefined(adapter.verifyFreshAuthentication)
      assert.deepEqual(profile, {
        subject: '123',
        email: 'person@example.test',
        emailVerified: state === 'verified',
        name: 'Person',
        nickname: 'person',
        avatarUrl: 'https://provider.test/avatar',
      })
    })
  }
})
