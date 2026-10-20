import { test } from '@japa/runner'
import { aceKernel } from './helpers/ace_kernel.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, makeUsersAdapter } from './helpers/fakes.js'
import { AccountKit } from '../src/account_kit.js'
import RetirementImpact from '../commands/retirement_impact.js'
import { dbTime } from './helpers/db_time.js'

test.group('authentication retirement impact', (group) => {
  const kit = useTestApp(group)

  test('counts accounts that would lose password login from adapter truth without mutation', async ({
    assert,
  }) => {
    await insertUser(kit, { email: 'password@example.test' })
    await insertUser(kit, { email: 'provider@example.test', password: null })
    const before = await kit.db.from('users').count('* as total').first()
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: {
        providers: {
          google: {
            authorizationUrl: async () => 'https://provider.example',
            resolve: async () => ({ subject: 'g-1', email: null, emailVerified: false }),
          },
          github: {
            authorizationUrl: async () => 'https://provider.example',
            resolve: async () => ({ subject: 'gh-1', email: null, emailVerified: false }),
          },
        },
      },
    })
    const impact = await account.authentication.retirementImpact({ passwordLogin: false })
    assert.equal(impact.inspectedAccounts, 2)
    assert.equal(impact.affectedAccounts, 1)
    assert.isTrue(Number.isFinite(Date.parse(impact.checkedAt)))
    assert.deepEqual(await kit.db.from('users').count('* as total').first(), before)
    const withProviderInventory = await account.authentication.retirementImpact({
      passwordLogin: false,
      providers: ['google'],
    })
    assert.equal(withProviderInventory.affectedAccounts, 1)
  })

  test('provider retirement counts only accounts losing their last confirmed usable method', async ({
    assert,
  }) => {
    const password = await insertUser(kit, { email: 'password@example.test' })
    const google = await insertUser(kit, { email: 'google@example.test', password: null })
    const both = await insertUser(kit, { email: 'both@example.test', password: null })
    const pending = await insertUser(kit, { email: 'pending@example.test', password: null })
    const now = dbTime(kit)
    await kit.db.table('social_identities').insert([
      {
        user_id: google.id,
        provider: 'google',
        provider_user_id: 'g-1',
        email: google.email,
        email_verified: true,
        confirmed_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        user_id: both.id,
        provider: 'google',
        provider_user_id: 'g-2',
        email: both.email,
        email_verified: true,
        confirmed_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        user_id: both.id,
        provider: 'github',
        provider_user_id: 'gh-2',
        email: both.email,
        email_verified: true,
        confirmed_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        user_id: pending.id,
        provider: 'google',
        provider_user_id: 'g-pending',
        email: pending.email,
        email_verified: true,
        confirmed_at: null,
        created_at: now,
        updated_at: now,
      },
    ])
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: {
        providers: {
          google: {
            authorizationUrl: async () => 'https://provider.example',
            resolve: async () => ({ subject: 'g-1', email: null, emailVerified: false }),
          },
          github: {
            authorizationUrl: async () => 'https://provider.example',
            resolve: async () => ({ subject: 'gh-1', email: null, emailVerified: false }),
          },
        },
      },
    })
    const retainPassword = await account.authentication.retirementImpact({
      passwordLogin: true,
      providers: ['github'],
    })
    assert.equal(retainPassword.inspectedAccounts, 4)
    assert.equal(retainPassword.affectedAccounts, 1)
    const retirePassword = await account.authentication.retirementImpact({
      passwordLogin: false,
      providers: ['github'],
    })
    assert.equal(retirePassword.affectedAccounts, 2)
    assert.equal(password.hasPassword, true)
  })

  test('booted Ace retirement inventory returns a structured count', async ({ assert }) => {
    await insertUser(kit, { email: 'password@example.test' })
    await insertUser(kit, { email: 'other@example.test', password: null })
    const { account } = makeService(kit, { authentication: { strategy: 'session', guard: 'web' } })
    kit.app.container.bindValue(AccountKit, account)
    const { kernel } = aceKernel(kit, [RetirementImpact])
    const result = await kernel.exec<typeof RetirementImpact>('account-kit:retirement-impact', [
      '--quiet',
    ])
    assert.isNotNull(result.impact)
    if (!result.impact) throw new Error('Missing retirement impact')
    assert.equal(result.impact.inspectedAccounts, 2)
    assert.equal(result.impact.affectedAccounts, 1)
    const retainPassword = await kernel.exec<typeof RetirementImpact>(
      'account-kit:retirement-impact',
      ['--quiet', '--keep-password-login', '--providers=github']
    )
    assert.isNull(retainPassword.failure)
    assert.equal(retainPassword.impact?.affectedAccounts, 0)
  })

  test('retirement inventory follows configured string IDs and user table', async ({ assert }) => {
    await kit.db.connection().schema.createTable('retirement_users', (table) => {
      table.string('id', 254).primary()
      table.string('email')
      table.string('password').nullable()
      table.string('unverified_email').nullable()
      table.timestamp('email_verified_at').nullable()
    })
    try {
      await kit.db.table('retirement_users').insert([
        { id: 'acct-a', email: 'a@example.test', password: await kit.hash.make('password123') },
        { id: 'acct-b', email: 'b@example.test', password: null },
      ])
      const { account } = makeService(kit, {
        users: makeUsersAdapter(kit.db, kit.hash, 'retirement_users'),
        usersTable: 'retirement_users',
        authentication: { strategy: 'session', guard: 'web' },
      })
      const impact = await account.authentication.retirementImpact({ passwordLogin: false })
      assert.equal(impact.inspectedAccounts, 2)
      assert.equal(impact.affectedAccounts, 1)
    } finally {
      await kit.db.connection().schema.dropTable('retirement_users')
    }
  })

  test('retirement inventory pages UUID-like IDs and trusts adapter password state without a password column', async ({
    assert,
  }) => {
    await kit.db.connection().schema.createTable('retirement_identities', (table) => {
      table.string('id', 254).primary()
    })
    try {
      const ids = Array.from(
        { length: 502 },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      )
      for (let index = 0; index < ids.length; index += 100)
        await kit.db
          .table('retirement_identities')
          .insert(ids.slice(index, index + 100).map((id) => ({ id })))
      const users = {
        ...makeUsersAdapter(kit.db, kit.hash, 'retirement_identities'),
        findById: async (id: number | string) => ({
          id,
          email: `${id}@example.test`,
          unverifiedEmail: null,
          hasPassword: id === ids[0] || id === ids[501],
          emailVerifiedAt: null,
        }),
      }
      const { account } = makeService(kit, {
        users,
        usersTable: 'retirement_identities',
        authentication: { strategy: 'session', guard: 'web' },
      })
      const impact = await account.authentication.retirementImpact({ passwordLogin: false })
      assert.equal(impact.inspectedAccounts, 502)
      assert.equal(impact.affectedAccounts, 2)
      const unresolved = makeService(kit, {
        users: { ...users, findById: async () => null },
        usersTable: 'retirement_identities',
        authentication: { strategy: 'session', guard: 'web' },
      })
      await assert.rejects(
        () => unresolved.account.authentication.retirementImpact({ passwordLogin: false }),
        /could not resolve/
      )
    } finally {
      await kit.db.connection().schema.dropTable('retirement_identities')
    }
  })
})
