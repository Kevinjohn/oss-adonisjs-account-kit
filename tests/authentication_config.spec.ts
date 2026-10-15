import { test } from '@japa/runner'
import { defineConfig } from '../src/config.js'
import { makeConfig } from './helpers/fakes.js'

const users = {
  findByEmail: async () => null,
  findById: async () => null,
  verifyPassword: async () => false,
} as never

test.group('authentication configuration', () => {
  test('uses one named guard and the documented defaults', ({ assert }) => {
    const config = defineConfig(
      makeConfig({
        users,
        enabled: [],
        authentication: { strategy: 'access_tokens', guard: 'api' },
      })
    )
    assert.deepEqual(config.authentication, {
      strategy: 'access_tokens',
      guard: 'api',
      canAccess: config.authentication?.canAccess,
      clientLimit: { requests: 10, duration: '1m' },
      identityLimit: { requests: 5, duration: '1m', blockDuration: '20m' },
      tokenAbilities: ['*'],
      tokenExpiresIn: null,
      tokenTable: 'auth_access_tokens',
    })
  })

  test('rejects unsupported topology and malformed authentication options', ({ assert }) => {
    const cases: Array<[unknown, string]> = [
      [null, 'authentication must be an object'],
      [{ strategy: 'dual', guard: 'api' }, 'strategy must be session or access_tokens'],
      [{ strategy: 'session', guard: '' }, 'guard must name an existing guard'],
      [{ strategy: 'session', guard: ['web', 'api'] }, 'guard must name an existing guard'],
      [{ strategy: 'session', guard: 'web', canAccess: true }, 'canAccess must be a function'],
      [
        { strategy: 'session', guard: 'web', clientLimit: { requests: 0, duration: '1m' } },
        'clientLimit.requests',
      ],
      [
        { strategy: 'session', guard: 'web', identityLimit: { requests: 5, duration: 'bad' } },
        'identityLimit.duration',
      ],
      [
        { strategy: 'session', guard: 'web', identityLimit: { blockDuration: 'bad' } },
        'identityLimit.blockDuration',
      ],
      [{ strategy: 'access_tokens', guard: 'api', tokenAbilities: [] }, 'tokenAbilities'],
      [{ strategy: 'access_tokens', guard: 'api', tokenExpiresIn: 'bad' }, 'TTL must'],
      [{ strategy: 'access_tokens', guard: 'api', tokenTable: 'bad-name' }, 'tokenTable'],
    ]
    for (const [authentication, message] of cases) {
      assert.throws(
        () =>
          defineConfig(makeConfig({ users, enabled: [], authentication: authentication as never })),
        message
      )
    }
  })
})
