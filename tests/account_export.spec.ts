import { test } from '@japa/runner'
import { exportFault } from '../src/account_export.js'
import {
  CapabilityDisabledError,
  IdentityNotConfirmedError,
  NoPasswordError,
  PostCommitError,
  SocialProofError,
  ThrottledError,
} from '../src/errors.js'
import type { AccountKitConfig, AccountUser, Trx } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { dbTime } from './helpers/db_time.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { issueRecentProof, past, seedAccountRows, soon } from './helpers/account_rows.js'
import { provider } from './helpers/social_identity.js'

const socialConfig: Partial<AccountKitConfig> = {
  enabled: ['dataExport', 'socialAuthentication', 'emailVerification'],
  registration: { availability: 'open' },
  socialAuthentication: { providers: { github: provider('subject', 'a@github.test', true) } },
  authentication: { strategy: 'session', guard: 'web' },
}

test.group('account data export', (group) => {
  const kit = useTestApp(group)
  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, { enabled: ['dataExport'], ...overrides })

  test('exports the account, identities, invitations and pending proofs and nothing else', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const other = await insertUser(kit, { email: 'other@example.test' })
    await seedAccountRows(kit, user.id, 'a')
    await seedAccountRows(kit, other.id, 'b')
    const { account } = service()
    const document = await account.accountData.export({
      actorId: user.id,
      currentPassword: 'password123',
    })
    assert.match(document.generatedAt, /^\d{4}-\d\d-\d\dT.*Z$/)
    assert.deepEqual(
      { ...document, generatedAt: 'now' },
      {
        format: 'adonisjs-account-kit/export',
        version: 1,
        generatedAt: 'now',
        account: {
          id: user.id,
          email: 'person@example.test',
          unverifiedEmail: null,
          emailVerifiedAt: user.emailVerifiedAt!.toUTC().toISO(),
          hasPassword: true,
          credentialsChangedAt: null,
        },
        socialIdentities: [
          {
            provider: 'github',
            providerUserId: 'subject-a',
            email: 'a@github.test',
            emailVerified: true,
            name: 'Name a',
            nickname: 'nick-a',
            avatarUrl: 'https://avatars.test/a.png',
            confirmedAt: '2026-01-02T03:04:05.000Z',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        invitationsSent: [
          {
            email: 'invitee-a@example.test',
            role: 'member',
            createdAt: '2026-11-01T00:00:00.000Z',
            expiresAt: '2026-12-01T00:00:00.000Z',
          },
        ],
        pending: {
          passwordReset: true,
          emailVerification: false,
          emailChange: 'a-new@example.test',
        },
        application: null,
      }
    )
  })

  test('the serialised export contains no stored secret of the account', async ({ assert }) => {
    const user = await insertUser(kit)
    const secrets = await seedAccountRows(kit, user.id, 'a')
    const { account } = service({ authentication: { strategy: 'access_tokens', guard: 'api' } })
    const text = JSON.stringify(
      await account.accountData.export({ actorId: user.id, currentPassword: 'password123' })
    )
    const stored = await kit.db.from('users').where('id', user.id).first()
    for (const secret of [...Object.values(secrets), stored.password])
      assert.notInclude(text, secret)
    assert.notInclude(text, '"meta"')
    assert.notInclude(text, 'hash')
  })

  test('access tokens are listed only for the token strategy', async ({ assert }) => {
    const user = await insertUser(kit)
    await seedAccountRows(kit, user.id, 'a')
    const input = { actorId: user.id, currentPassword: 'password123' }
    const tokens = await service({
      authentication: { strategy: 'access_tokens', guard: 'api' },
    }).account.accountData.export(input)
    assert.lengthOf(tokens.accessTokens!, 1)
    assert.deepInclude(tokens.accessTokens![0], {
      name: 'Laptop a',
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null,
    })
    const sessions = await service({
      authentication: { strategy: 'session', guard: 'web' },
    }).account.accountData.export(input)
    assert.notProperty(sessions, 'accessTokens')
  })

  test('pending flags follow only unexpired proofs', async ({ assert }) => {
    const user = await insertUser(kit, { verified: false })
    const { account } = service()
    const input = { actorId: user.id, currentPassword: 'password123' }
    const empty = await account.accountData.export(input)
    assert.deepEqual(empty.pending, {
      passwordReset: false,
      emailVerification: false,
      emailChange: null,
    })
    await kit.db.table('email_verification_tokens').insert({
      tokenable_id: user.id,
      email: user.email,
      current_email: user.email,
      purpose: 'activation',
      hash: 'h'.repeat(64),
      expires_at: soon(kit),
      created_at: dbTime(kit, '2026-01-01T00:00:00.000Z'),
    })
    await kit.db.table('password_reset_tokens').insert({
      tokenable_id: user.id,
      email: user.email,
      hash: 'r'.repeat(64),
      expires_at: past(kit),
      created_at: dbTime(kit, '2026-01-01T00:00:00.000Z'),
    })
    const document = await account.accountData.export(input)
    assert.deepEqual(document.pending, {
      passwordReset: false,
      emailVerification: true,
      emailChange: null,
    })
    assert.equal(document.account.unverifiedEmail, user.email)
    assert.isNull(document.account.emailVerifiedAt)
  })

  test('the application section is normalised JSON from inside the transaction', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const seen: Array<[AccountUser, boolean]> = []
    const { account } = service({
      exportAccountData: async (actor: AccountUser, trx: Trx) => {
        seen.push([actor, trx.isTransaction])
        const row = await trx.from('users').where('id', actor.id).first()
        return { email: row.email, at: new Date('2026-05-06T07:08:09.000Z'), skip: undefined }
      },
    })
    const document = await account.accountData.export({
      actorId: user.id,
      currentPassword: 'password123',
    })
    assert.deepEqual(document.application, {
      email: 'person@example.test',
      at: '2026-05-06T07:08:09.000Z',
    })
    assert.equal(seen[0][0].id, user.id)
    assert.isTrue(seen[0][1])
  })

  test('an unserialisable application section fails before commit and keeps the proof', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { password: null })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const value of [undefined, BigInt(1), circular, () => 1]) {
      const { account, config } = makeService(kit, {
        ...socialConfig,
        exportAccountData: async () => value,
      })
      const proof = await issueRecentProof(kit, config, user.id, 'account_export')
      await assert.rejects(
        () => account.accountData.export({ actorId: user.id, recentProof: proof }),
        /exportAccountData must return JSON-serialisable data/
      )
      assert.lengthOf(await kit.db.from('social_sensitive_proofs').where('user_id', user.id), 1)
      await kit.db.from('social_sensitive_proofs').delete()
    }
  })

  test('a fault after commit still returns the document and records the fault', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const failure = new Error('commit listener failed')
    const { account } = service({
      exportAccountData: async (_user: AccountUser, trx: Trx) => {
        trx.on('commit', () => {
          throw failure
        })
        return { ok: true }
      },
    })
    const document = await account.accountData.export({
      actorId: user.id,
      currentPassword: 'password123',
    })
    assert.deepEqual(document.application, { ok: true })
    assert.equal(document.account.id, user.id)
    const fault = exportFault(document)
    assert.instanceOf(fault, PostCommitError)
    assert.equal(fault!.cause, failure)
    const clean = await service().account.accountData.export({
      actorId: user.id,
      currentPassword: 'password123',
    })
    assert.isUndefined(exportFault(clean))
  })

  test('a password-less account proves itself with a single-use account_export proof', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { password: null })
    const other = await insertUser(kit, { email: 'other@example.test', password: null })
    const { account, config } = makeService(kit, {
      ...socialConfig,
      throttle: { requests: 20, duration: '1m' },
    })
    const exportOf = (recentProof?: string) =>
      account.accountData.export({ actorId: user.id, recentProof })

    await assert.rejects(() => exportOf(), IdentityNotConfirmedError)
    const wrongPurpose = await issueRecentProof(kit, config, user.id, 'account_delete')
    await assert.rejects(() => exportOf(wrongPurpose), SocialProofError)
    const theirs = await issueRecentProof(kit, config, other.id, 'account_export')
    await assert.rejects(() => exportOf(theirs), SocialProofError)
    const expired = await issueRecentProof(kit, config, user.id, 'account_export')
    await kit.db.from('social_sensitive_proofs').update({ expires_at: past(kit) })
    await assert.rejects(() => exportOf(expired), SocialProofError)

    const proof = await issueRecentProof(kit, config, user.id, 'account_export')
    const document = await exportOf(proof)
    assert.isFalse(document.account.hasPassword)
    await assert.rejects(() => exportOf(proof), SocialProofError)

    const { account: withoutSocial } = service()
    await assert.rejects(
      () => withoutSocial.accountData.export({ actorId: user.id, recentProof: proof }),
      NoPasswordError
    )
  })

  test('a wrong password is refused and every attempt counts against the identity budget', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = service({ throttle: { requests: 2, duration: '1m' } })
    await assert.rejects(
      () => account.accountData.export({ actorId: user.id, currentPassword: 'wrong-password' }),
      IdentityNotConfirmedError
    )
    await account.accountData.export({ actorId: user.id, currentPassword: 'password123' })
    await assert.rejects(
      () => account.accountData.export({ actorId: user.id, currentPassword: 'password123' }),
      ThrottledError
    )
  })

  test('export needs the capability', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit)
    await assert.rejects(
      () => account.accountData.export({ actorId: user.id, currentPassword: 'password123' }),
      CapabilityDisabledError
    )
  })
})
