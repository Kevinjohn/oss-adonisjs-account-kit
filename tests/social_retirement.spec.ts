import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
import { makeService, makeUsersAdapter } from './helpers/fakes.js'
import { dbTime } from './helpers/db_time.js'

test.group('social provider retirement inventory', (group) => {
  const kit = useTestApp(group)

  test('uses configured user table and string IDs while excluding pending identities', async ({
    assert,
  }) => {
    await resetSchema(kit, { usersTable: 'account_users', stringUserIds: true })
    const now = dbTime(kit)
    await kit.db.table('account_users').insert([
      { id: 'acct-google', email: 'google@example.test', password: null, created_at: now },
      { id: 'acct-pending', email: 'pending@example.test', password: null, created_at: now },
      {
        id: 'acct-password',
        email: 'password@example.test',
        password: await kit.hash.make('password123'),
        created_at: now,
      },
    ])
    await kit.db.table('social_identities').insert([
      {
        user_id: 'acct-google',
        provider: 'google',
        provider_user_id: 'g-1',
        email: 'google@example.test',
        email_verified: true,
        confirmed_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        user_id: 'acct-pending',
        provider: 'github',
        provider_user_id: 'gh-pending',
        email: 'pending@example.test',
        email_verified: true,
        confirmed_at: null,
        created_at: now,
        updated_at: now,
      },
    ])
    const { account } = makeService(kit, {
      users: makeUsersAdapter(kit.db, kit.hash, 'account_users'),
      usersTable: 'account_users',
      authentication: { strategy: 'session', guard: 'web' },
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: {
        providers: {
          google: {
            authorizationUrl: async () => 'https://provider.example',
            resolve: async () => ({ subject: 'g-1', email: null, emailVerified: false }),
          },
        },
      },
    })
    const impact = await account.authentication.retirementImpact({
      passwordLogin: true,
      providers: ['github'],
    })
    assert.equal(impact.inspectedAccounts, 3)
    assert.equal(impact.affectedAccounts, 1)
    const { account: githubOnly } = makeService(kit, {
      users: makeUsersAdapter(kit.db, kit.hash, 'account_users'),
      usersTable: 'account_users',
      authentication: { strategy: 'session', guard: 'web' },
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: {
        providers: {
          github: {
            authorizationUrl: async () => 'https://provider.example',
            resolve: async () => ({ subject: 'gh-1', email: null, emailVerified: false }),
          },
        },
      },
    })
    const disabledGoogle = await githubOnly.authentication.retirementImpact({
      passwordLogin: true,
      providers: [],
    })
    assert.equal(disabledGoogle.affectedAccounts, 0)
    assert.deepEqual(disabledGoogle.currentProviders, ['github'])
    await kit.db.table('account_users').insert({
      id: 'acct-github',
      email: 'github@example.test',
      password: null,
      created_at: now,
    })
    await kit.db.table('social_identities').insert({
      user_id: 'acct-github',
      provider: 'github',
      provider_user_id: 'gh-confirmed',
      email: 'github@example.test',
      email_verified: true,
      confirmed_at: now,
      created_at: now,
      updated_at: now,
    })
    const { account: bothEnabled } = makeService(kit, {
      users: makeUsersAdapter(kit.db, kit.hash, 'account_users'),
      usersTable: 'account_users',
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
    const droppingGithub = await bothEnabled.authentication.retirementImpact({
      passwordLogin: true,
      providers: ['google'],
    })
    assert.deepEqual(droppingGithub.currentProviders, ['google', 'github'])
    assert.equal(droppingGithub.affectedAccounts, 1)
    await kit.db.table('social_identities').insert({
      user_id: 'acct-pending',
      provider: 'unknown',
      provider_user_id: 'subject-1',
      email: 'pending@example.test',
      email_verified: true,
      confirmed_at: now,
      created_at: now,
      updated_at: now,
    })
    await assert.rejects(
      () => account.authentication.retirementImpact({ passwordLogin: true, providers: [] }),
      /Unknown confirmed provider/
    )
  })
})
