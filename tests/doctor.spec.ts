import { test } from '@japa/runner'
import AccountKitDoctor from '../commands/doctor.js'
import { defineConfig } from '../src/config.js'
import { runDoctor, type DoctorInput } from '../src/doctor.js'
import { aceKernel } from './helpers/ace_kernel.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
import { provider } from './helpers/social_identity.js'

test.group('account-kit:doctor', (group) => {
  const kit = useTestApp(group)

  function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
    return {
      config: defineConfig(makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })),
      db: kit.db,
      limiterBound: true,
      appUrl: 'https://example.test',
      environment: 'production',
      ...overrides,
    }
  }
  const failures = (checks: Awaited<ReturnType<typeof runDoctor>>) =>
    checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`)

  test('passes a complete installation', async ({ assert }) => {
    const checks = await runDoctor(input())
    assert.deepEqual(failures(checks), [])
    assert.deepEqual(
      checks.map((check) => check.name),
      ['Config', 'Limiter', 'APP_URL', 'Package tables', 'Users table']
    )
  })

  test('reports a missing config and skips database checks', async ({ assert }) => {
    const checks = await runDoctor(input({ config: undefined }))
    assert.deepEqual(failures(checks), [
      'Config: config/account_kit.ts is missing or does not export defineConfig(...)',
    ])
    assert.notInclude(
      checks.map((check) => check.name),
      'Package tables'
    )
  })

  test('reports a missing limiter and an unsafe APP_URL', async ({ assert }) => {
    assert.deepEqual(failures(await runDoctor(input({ limiterBound: false, appUrl: undefined }))), [
      'Limiter: @adonisjs/limiter is not registered',
      'APP_URL: is not set',
    ])
    assert.deepEqual(failures(await runDoctor(input({ appUrl: 'http://example.test' }))), [
      'APP_URL: must use HTTPS in production',
    ])
    assert.deepEqual(
      failures(
        await runDoctor(input({ appUrl: 'http://localhost:3333', environment: 'development' }))
      ),
      []
    )
    assert.deepEqual(
      failures(await runDoctor(input({ appUrl: 'localhost:3333', environment: 'development' }))),
      ['APP_URL: must start with http:// or https://']
    )
  })

  test('names each missing table for the enabled capabilities', async ({ assert }) => {
    try {
      await kit.db.connection().schema.dropTable('account_invitations')
      const enabledWithoutInvitations = defineConfig(
        makeConfig({
          users: makeUsersAdapter(kit.db, kit.hash),
          enabled: ['passwordReset', 'emailVerification', 'emailPasswordManagement'],
        })
      )
      assert.deepEqual(failures(await runDoctor(input({ config: enabledWithoutInvitations }))), [])
      const checks = await runDoctor(input())
      assert.deepEqual(failures(checks), ['Package tables: missing account_invitations'])
      assert.match(checks.find((check) => !check.ok)!.fix!, /migration:run/)
    } finally {
      await resetSchema(kit)
    }
  })

  test('requires the sign-in link table even while magic links are off', async ({ assert }) => {
    try {
      await kit.db.connection().schema.dropTable('login_link_tokens')
      const config = defineConfig(
        makeConfig({ users: makeUsersAdapter(kit.db, kit.hash), enabled: ['passwordReset'] })
      )
      assert.deepEqual(failures(await runDoctor(input({ config }))), [
        'Package tables: missing login_link_tokens',
      ])
    } finally {
      await resetSchema(kit)
    }
  })

  test('requires the recovery-token table another enabled flow clears', async ({ assert }) => {
    try {
      await kit.db.connection().schema.dropTable('password_reset_tokens')
      const verificationOnly = defineConfig(
        makeConfig({ users: makeUsersAdapter(kit.db, kit.hash), enabled: ['emailVerification'] })
      )
      assert.deepEqual(failures(await runDoctor(input({ config: verificationOnly }))), [
        'Package tables: missing password_reset_tokens',
      ])
    } finally {
      await resetSchema(kit)
    }
  })

  test('deletion requires cleanup tables even when their capabilities are disabled', async ({
    assert,
  }) => {
    const deletionOnly = defineConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        enabled: ['accountDeletion'],
      })
    )
    try {
      await kit.db.connection().schema.dropTable('social_handoff_codes')
      assert.deepEqual(failures(await runDoctor(input({ config: deletionOnly }))), [
        'Package tables: missing social_handoff_codes',
      ])
    } finally {
      await resetSchema(kit)
    }
    try {
      await kit.db.connection().schema.dropTable('account_invitations')
      assert.deepEqual(failures(await runDoctor(input({ config: deletionOnly }))), [
        'Package tables: missing account_invitations',
      ])
    } finally {
      await resetSchema(kit)
    }
  })

  test('deletion requires the selected token table but not tokens in session mode', async ({
    assert,
  }) => {
    try {
      await kit.db.connection().schema.dropTable('auth_access_tokens')
      const tokenConfig = defineConfig(
        makeConfig({
          users: makeUsersAdapter(kit.db, kit.hash),
          enabled: ['accountDeletion'],
          authentication: {
            strategy: 'access_tokens',
            guard: 'api',
            tokenTable: 'custom_api_tokens',
          },
        })
      )
      assert.deepEqual(failures(await runDoctor(input({ config: tokenConfig }))), [
        'Package tables: missing custom_api_tokens',
      ])
      const sessionConfig = defineConfig(
        makeConfig({
          users: makeUsersAdapter(kit.db, kit.hash),
          enabled: ['accountDeletion'],
          authentication: { strategy: 'session', guard: 'web' },
        })
      )
      assert.deepEqual(failures(await runDoctor(input({ config: sessionConfig }))), [])
    } finally {
      await resetSchema(kit)
    }
  })

  test('passwordless social registration requires a nullable password', async ({ assert }) => {
    try {
      await kit.db.connection().schema.alterTable('users', (table) => {
        table.string('password').notNullable().alter()
      })
      const options = {
        users: makeUsersAdapter(kit.db, kit.hash),
        enabled: ['emailVerification', 'socialAuthentication'] as const,
        authentication: { strategy: 'access_tokens' as const, guard: 'api' },
        socialAuthentication: {
          providers: { google: provider('doctor', 'person@example.test', true) },
        },
      }
      const open = defineConfig(makeConfig({ ...options, enabled: [...options.enabled] }))
      assert.deepEqual(failures(await runDoctor(input({ config: open }))), [
        'Users table: users.password must allow NULL for social registration',
      ])
      const closed = defineConfig(
        makeConfig({
          ...options,
          enabled: [...options.enabled],
          registration: { availability: 'closed' },
        })
      )
      assert.deepEqual(failures(await runDoctor(input({ config: closed }))), [])
      const passwordOnly = defineConfig(
        makeConfig({ users: options.users, enabled: ['registration'] })
      )
      assert.deepEqual(failures(await runDoctor(input({ config: passwordOnly }))), [])
    } finally {
      await resetSchema(kit)
    }
  })

  test('reports a users table that does not exist', async ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = defineConfig(
      makeConfig({
        users: {
          ...users,
          resolveMetadata: async () => ({ table: 'absent_users', primaryKey: 'id' as const }),
        },
      })
    )
    assert.deepEqual(failures(await runDoctor(input({ config }))), [
      'Users table: table absent_users does not exist',
    ])
  })

  test('the Ace command prints each check and exits 1 on a failure', async ({ assert }) => {
    const previous = process.env.APP_URL
    let callbackCalls = 0
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    kit.app.config.set(
      'account_kit',
      defineConfig({
        ...base,
        notify: {
          ...base.notify,
          passwordResetProvision: async () => {
            callbackCalls++
          },
        },
        onCredentialsChangedTransaction: async () => {
          callbackCalls++
        },
      })
    )
    const { kernel } = aceKernel(kit, [AccountKitDoctor])
    const successes: string[] = []
    const errors: string[] = []
    const infos: string[] = []
    kernel.ui.logger.success = (message) => {
      successes.push(message)
    }
    kernel.ui.logger.error = (message) => {
      errors.push(String(message))
    }
    kernel.ui.logger.info = (message) => {
      infos.push(String(message))
    }
    try {
      process.env.APP_URL = 'http://localhost:3333'
      const passing = await kernel.exec('account-kit:doctor', [])
      assert.equal(passing.exitCode, 0)
      assert.lengthOf(successes, 5)
      assert.deepEqual(errors, [])
      assert.isTrue(
        infos.some((message) =>
          message.includes(
            'Unverified: notification callbacks and delivery, credential revocation, and application policy'
          )
        )
      )
      assert.isTrue(infos.some((message) => message.includes('Smoke test:')))
      assert.equal(callbackCalls, 0)

      const passingInfoCount = infos.length
      delete process.env.APP_URL
      const failing = await kernel.exec('account-kit:doctor', [])
      assert.equal(failing.exitCode, 1)
      assert.deepEqual(errors, ['APP_URL: is not set. Set APP_URL to the public base URL'])
      assert.lengthOf(infos, passingInfoCount)
    } finally {
      if (previous === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previous
      kit.app.config.set('account_kit', undefined)
    }
  })
})
