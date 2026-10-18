import { test } from '@japa/runner'
import { Kernel, ListLoader } from '@adonisjs/core/ace'
import AccountKitDoctor from '../commands/doctor.js'
import { defineConfig } from '../src/config.js'
import { runDoctor, type DoctorInput } from '../src/doctor.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'

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

  test('names columns that a later migration adds', async ({ assert }) => {
    try {
      await kit.db.connection().schema.alterTable('password_reset_tokens', (table) => {
        table.renameColumn('hash', 'token_hash')
      })
      const checks = await runDoctor(input())
      assert.deepEqual(failures(checks), [
        'Package tables: missing columns password_reset_tokens.hash',
      ])
      assert.match(checks.find((check) => !check.ok)!.fix!, /migration:run/)
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
    kit.app.config.set(
      'account_kit',
      defineConfig(makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) }))
    )
    const kernel = new Kernel(kit.app)
    kernel.addLoader(new ListLoader([AccountKitDoctor]))
    const successes: string[] = []
    const errors: string[] = []
    kernel.ui.logger.success = (message) => {
      successes.push(message)
    }
    kernel.ui.logger.error = (message) => {
      errors.push(String(message))
    }
    try {
      process.env.APP_URL = 'http://localhost:3333'
      const passing = await kernel.exec('account-kit:doctor', [])
      assert.equal(passing.exitCode, 0)
      assert.lengthOf(successes, 5)
      assert.deepEqual(errors, [])

      delete process.env.APP_URL
      const failing = await kernel.exec('account-kit:doctor', [])
      assert.equal(failing.exitCode, 1)
      assert.deepEqual(errors, ['APP_URL: is not set. Set APP_URL to the public base URL'])
    } finally {
      if (previous === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previous
      kit.app.config.set('account_kit', undefined)
    }
  })
})
