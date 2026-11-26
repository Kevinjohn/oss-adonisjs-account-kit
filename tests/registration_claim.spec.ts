import { test } from '@japa/runner'
import {
  E_ACCOUNT_KIT_UNVERIFIED_EMAIL,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_INVALID_CREDENTIALS,
  E_ACCOUNT_KIT_INVALID_SESSION,
} from '../src/errors.ts'
import { useTestApp } from './helpers/app.ts'
import { accessTokenDefaults } from './helpers/access_tokens.ts'
import { makeService, tokenFrom } from './helpers/fakes.ts'

test.group('registration', (group) => {
  const kit = useTestApp(group)

  test('a claimant replaces the precreator password before activation and revokes earlier credentials', async ({
    assert,
  }) => {
    const calls: string[] = []
    const service = makeService(kit, {
      enabled: ['registration', 'emailVerification'],
      registration: { availability: 'open' },
      onCredentialsChangedTransaction: async (user, context, trx) => {
        const row = await trx.from('users').where('id', user.id).first()
        assert.isNull(row.unverified_email)
        assert.equal(context.operation, 'registration_claim')
        calls.push('revoke')
      },
    })
    const user = await service.account.registration.register({
      email: 'victim@example.test',
      password: 'attackerPassword123',
    })
    const token = tokenFrom(service.recorder.calls[0].args[1])
    await assert.rejects(
      () => service.account.emailVerification.complete({ token } as never),
      E_ACCOUNT_KIT_INVALID_INPUT
    )
    // eslint-disable-next-line @unicorn/no-await-expression-member -- Assert the result at the call site.
    assert.equal((await kit.db.from('email_verification_tokens')).length, 1)
    await service.account.emailVerification.complete({ token, password: 'VictimPassword123' })
    assert.deepEqual(calls, ['revoke'])
    const trx = await kit.db.transaction()
    try {
      assert.isFalse(await service.users.verifyPassword(user.id, 'attackerPassword123', trx))
      assert.isTrue(await service.users.verifyPassword(user.id, 'VictimPassword123', trx))
    } finally {
      await trx.rollback()
    }
  })

  test('bearer login is limited, and claiming revokes both existing and in-flight tokens', async ({
    assert,
  }) => {
    const service = makeService(kit, {
      enabled: ['registration', 'emailVerification'],
      registration: { availability: 'open' },
      authentication: { strategy: 'access_tokens', guard: 'api' },
    })
    const user = await service.account.registration.register({
      email: 'victim@example.test',
      password: 'attackerPassword123',
    })
    const token = tokenFrom(service.recorder.calls[0].args[1])
    const guard = {
      strategy: 'access_tokens' as const,
      name: 'api',
      establish: async (userId: number | string) => {
        const [id] = await kit.db
          .table('auth_access_tokens')
          .insert({ tokenable_id: userId, ...accessTokenDefaults, hash: 'credential' })
          .returning('id')
        return { id: typeof id === 'object' ? id.id : id, userId }
      },
      terminate: async (credential?: { id: number | string; userId: number | string }) => {
        if (credential) await kit.db.from('auth_access_tokens').where('id', credential.id).delete()
      },
    }
    const limited = await service.account.authentication.login(
      { email: user.email, password: 'attackerPassword123', clientKey: 'first' },
      guard
    )
    assert.isFalse(limited.account.active)
    await assert.rejects(
      () =>
        service.account.authentication.requireActive({
          userId: user.id,
          tokenId: limited.credential.id,
        }),
      E_ACCOUNT_KIT_UNVERIFIED_EMAIL
    )
    const inFlight = service.account.authentication.login(
      { email: user.email, password: 'attackerPassword123', clientKey: 'second' },
      {
        ...guard,
        establish: async (userId: number | string) => {
          const credential = await guard.establish(userId)
          await service.account.emailVerification.complete({ token, password: 'VictimPassword123' })
          return credential
        },
      }
    )
    await assert.rejects(() => inFlight, E_INVALID_CREDENTIALS)
    assert.lengthOf(await kit.db.from('auth_access_tokens'), 0)
    await assert.rejects(
      () =>
        service.account.authentication.current({ userId: user.id, tokenId: limited.credential.id }),
      E_ACCOUNT_KIT_INVALID_SESSION
    )
    await assert.rejects(
      () =>
        service.account.authentication.login(
          { email: user.email, password: 'attackerPassword123', clientKey: 'third' },
          guard
        ),
      E_INVALID_CREDENTIALS
    )
  })

  test('session issuance after claim rejects the old password and earlier session revision', async ({
    assert,
  }) => {
    const service = makeService(kit, {
      enabled: ['registration', 'emailVerification'],
      registration: { availability: 'open' },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const user = await service.account.registration.register({
      email: 'victim@example.test',
      password: 'attackerPassword123',
    })
    const token = tokenFrom(service.recorder.calls[0].args[1])
    const guard = {
      strategy: 'session' as const,
      name: 'web',
      establish: async (_userId: number | string, revision: string | null) => revision,
      terminate: async () => {},
    }
    const limited = await service.account.authentication.login(
      { email: user.email, password: 'attackerPassword123', clientKey: 'first' },
      guard
    )
    assert.isFalse(limited.account.active)
    await assert.rejects(
      () =>
        service.account.authentication.requireActive({
          userId: user.id,
          revision: limited.credential,
        }),
      E_ACCOUNT_KIT_UNVERIFIED_EMAIL
    )
    await service.account.emailVerification.complete({ token, password: 'VictimPassword123' })
    await assert.rejects(
      () =>
        service.account.authentication.current({ userId: user.id, revision: limited.credential }),
      E_ACCOUNT_KIT_INVALID_SESSION
    )
    await assert.rejects(
      () =>
        service.account.authentication.login(
          { email: user.email, password: 'attackerPassword123', clientKey: 'second' },
          guard
        ),
      E_INVALID_CREDENTIALS
    )
  })
})
