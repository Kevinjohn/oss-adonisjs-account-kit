import { test } from '@japa/runner'
import AccountKitDoctor from '../commands/doctor.ts'
import { AccountKitCallbackConfiguration } from '../src/account_kit_callback_configuration.ts'
import { createActionUrls } from '../src/action_urls.ts'
import { defineConfig, resolveConfig } from '../src/config.ts'
import { runDoctor, type DoctorInput } from '../src/doctor.ts'
import { aceKernel } from './helpers/ace_kernel.ts'
import { bootTestApp, useTestApp } from './helpers/app.ts'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.ts'
import { resetSchema } from './helpers/schema.ts'
import { provider } from './helpers/social_identity.ts'
import { testEngine } from './helpers/dialect.ts'

test.group('account-kit:doctor', (group) => {
  const kit = useTestApp(group, { accountKitProvider: 'source' })

  function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
    return {
      config: resolveConfig(makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })),
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
    assert.deepEqual(failures(await runDoctor(input({ appUrl: '/relative' }))), [
      'APP_URL: is not an absolute URL',
    ])
  })

  test('names each missing table for the enabled capabilities', async ({ assert }) => {
    try {
      await kit.db.connection().schema.dropTable('account_invitations')
      const enabledWithoutInvitations = resolveConfig(
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

  test('names the invitation scope column an older installation lacks', async ({ assert }) => {
    try {
      await kit.db.connection().schema.alterTable('account_invitations', (table) => {
        table.dropUnique(['email', 'scope'])
      })
      await kit.db.connection().schema.alterTable('account_invitations', (table) => {
        table.dropColumn('scope')
      })
      assert.deepEqual(failures(await runDoctor(input())), [
        'Package tables: missing account_invitations.scope',
      ])
    } finally {
      await resetSchema(kit)
    }
  })

  test('requires the sign-in link table even while magic links are off', async ({ assert }) => {
    try {
      await kit.db.connection().schema.dropTable('login_link_tokens')
      const config = resolveConfig(
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
      const verificationOnly = resolveConfig(
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
    const deletionOnly = resolveConfig(
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

  test('deletion requires the session table after authentication is disabled', async ({
    assert,
  }) => {
    const config = resolveConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        enabled: ['accountDeletion'],
        authentication: undefined,
      })
    )
    try {
      await kit.db.connection().schema.dropTable('account_sessions')
      assert.deepEqual(failures(await runDoctor(input({ config }))), [
        'Package tables: missing account_sessions',
      ])
    } finally {
      await resetSchema(kit)
    }
  })
  test('token authentication requires its configured table without export or deletion', async ({
    assert,
  }) => {
    const config = resolveConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        enabled: ['passwordReset'],
        authentication: {
          strategy: 'access_tokens',
          guard: 'api',
          tokenTable: 'custom_api_tokens',
        },
      })
    )
    const checks = await runDoctor(input({ config }))
    assert.deepEqual(failures(checks), ['Package tables: missing custom_api_tokens'])
    assert.match(checks.find((check) => check.name === 'Package tables')!.fix!, /Auth/)
  })
  test('deletion requires the selected token table but not tokens in session mode', async ({
    assert,
  }) => {
    try {
      await kit.db.connection().schema.dropTable('auth_access_tokens')
      const tokenConfig = resolveConfig(
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
      const sessionConfig = resolveConfig(
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

  // Four schema rebuilds outlast Japa's 2s default on MySQL.
  test('export requires every table it reads', async ({ assert }) => {
    const exportOnly = resolveConfig(
      makeConfig({ users: makeUsersAdapter(kit.db, kit.hash), enabled: ['dataExport'] })
    )
    for (const table of [
      'social_identities',
      'account_invitations',
      'password_reset_tokens',
      'email_verification_tokens',
    ]) {
      try {
        // PostgreSQL and MySQL refuse to drop a table other tables reference; drop only their keys.
        if (testEngine === 'pg') await kit.db.rawQuery(`drop table ${table} cascade`)
        else {
          if (testEngine === 'mysql') {
            const [references] = await kit.db.rawQuery(
              'select table_name as owner, constraint_name as name from information_schema.referential_constraints where constraint_schema = database() and referenced_table_name = ?',
              [table]
            )
            for (const { owner, name } of references as Array<{ owner: string; name: string }>)
              await kit.db.rawQuery(`alter table \`${owner}\` drop foreign key \`${name}\``)
          }
          await kit.db.connection().schema.dropTable(table)
        }
        assert.deepEqual(failures(await runDoctor(input({ config: exportOnly }))), [
          `Package tables: missing ${table}`,
        ])
      } finally {
        await resetSchema(kit)
      }
    }
  }).timeout(10_000)

  test('names users-table columns the configuration needs', async ({ assert }) => {
    const withLogin = resolveConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        authentication: { strategy: 'session', guard: 'web' },
      })
    )
    const withoutLogin = resolveConfig(makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) }))
    try {
      await kit.db.connection().schema.alterTable('users', (table) => {
        table.dropColumn('credentials_changed_at')
      })
      assert.deepEqual(failures(await runDoctor(input({ config: withLogin }))), [
        'Users table: users is missing credentials_changed_at',
      ])
      assert.deepEqual(failures(await runDoctor(input({ config: withoutLogin }))), [])
    } finally {
      await resetSchema(kit)
    }
  })

  test('SQLite requires the transaction lock table', async ({ assert }) => {
    try {
      await kit.db.connection().schema.dropTable('account_transaction_lock')
      assert.deepEqual(failures(await runDoctor(input())), [
        'Package tables: missing account_transaction_lock',
      ])
    } finally {
      await resetSchema(kit)
    }
  }).skip(testEngine !== 'sqlite', 'Only SQLite serializes writers through the lock table')

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
      const open = resolveConfig(makeConfig({ ...options, enabled: [...options.enabled] }))
      assert.deepEqual(failures(await runDoctor(input({ config: open }))), [
        'Users table: users.password must allow NULL for social registration',
      ])
      const closed = resolveConfig(
        makeConfig({
          ...options,
          enabled: [...options.enabled],
          registration: { availability: 'closed' },
        })
      )
      assert.deepEqual(failures(await runDoctor(input({ config: closed }))), [])
      const passwordOnly = resolveConfig(
        makeConfig({ users: options.users, enabled: ['registration'] })
      )
      assert.deepEqual(failures(await runDoctor(input({ config: passwordOnly }))), [])
    } finally {
      await resetSchema(kit)
    }
  })

  test('reports user metadata that cannot be resolved', async ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = resolveConfig(
      makeConfig({
        users: {
          ...users,
          resolveMetadata: async () => {
            throw new Error('metadata unavailable')
          },
        },
      })
    )
    assert.deepEqual(failures(await runDoctor(input({ config }))), [
      'Users table: metadata unavailable',
    ])
  })

  test('sign-in requires the session registry table', async ({ assert }) => {
    const withLogin = resolveConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        authentication: { strategy: 'session', guard: 'web' },
      })
    )
    try {
      await kit.db.connection().schema.dropTable('account_sessions')
      assert.deepEqual(failures(await runDoctor(input({ config: withLogin }))), [
        'Package tables: missing account_sessions',
      ])
      assert.deepEqual(failures(await runDoctor(input())), [])
    } finally {
      await resetSchema(kit)
    }
  })

  test('the Ace command distinguishes a missing users table from missing package columns', async ({
    assert,
  }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = defineConfig(
      makeConfig({
        users: {
          ...users,
          resolveMetadata: async () => ({ table: 'absent_users', primaryKey: 'id' as const }),
        },
      })
    )
    kit.app.config.set('account_kit', config)
    const { kernel } = aceKernel(kit, [AccountKitDoctor])
    const errors: string[] = []
    kernel.ui.logger.error = (message) => {
      errors.push(String(message))
    }
    let appUrl: string | undefined
    try {
      appUrl = 'https://example.test'
      const absent = await kernel.exec('account-kit:doctor', appUrl ? [`--app-url=${appUrl}`] : [])
      assert.equal(absent.exitCode, 1)
      assert.deepEqual(errors, [
        "Users table: table absent_users does not exist. Verify the configured users table mapping. Restore absent_users from a backup or run the application's own users migration as appropriate",
      ])

      await kit.db.connection().schema.createTable('absent_users', (table) => {
        table.increments('id')
        table.string('email')
        table.string('password')
      })
      errors.length = 0
      const missingColumns = await kernel.exec(
        'account-kit:doctor',
        appUrl ? [`--app-url=${appUrl}`] : []
      )
      assert.equal(missingColumns.exitCode, 1)
      assert.deepEqual(errors, [
        'Users table: absent_users is missing unverified_email, email_verified_at. Run `node ace configure @kevinjohn/adonisjs-account-kit`, then `node ace migration:run`',
      ])
    } finally {
      kit.app.config.set('account_kit', undefined)
      await kit.db.connection().schema.dropTableIfExists('absent_users')
    }
  })

  test('the Ace command reads users registered through AccountKitCallbackConfiguration', async ({
    assert,
  }) => {
    const app = await bootTestApp({ accountKitProvider: 'source' })
    let appUrl: string | undefined
    try {
      const users = makeUsersAdapter(app.db, app.hash)
      const config = makeConfig({ users: undefined })
      app.app.config.set('account_kit', defineConfig({ ...config, authorize: undefined }))
      const registry = await app.app.container.make(AccountKitCallbackConfiguration)
      registry.register(() => ({
        authorize: config.authorize,
        users: {
          ...users,
          resolveMetadata: async () => ({ table: 'absent_users', primaryKey: 'id' as const }),
        },
      }))
      const { kernel } = aceKernel(app, [AccountKitDoctor])
      const errors: string[] = []
      kernel.ui.logger.error = (message) => {
        errors.push(String(message))
      }
      appUrl = 'https://example.test'
      const command = await kernel.exec('account-kit:doctor', appUrl ? [`--app-url=${appUrl}`] : [])
      assert.equal(command.exitCode, 1)
      assert.match(errors.join('\n'), /table absent_users does not exist/)
    } finally {
      await app.close()
    }
  })

  test('the Ace command prints each check and exits 1 on a failure', async ({ assert }) => {
    let appUrl: string | undefined
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
      appUrl = 'http://localhost:3333'
      const passing = await kernel.exec('account-kit:doctor', appUrl ? [`--app-url=${appUrl}`] : [])
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
      appUrl = undefined
      const failing = await kernel.exec('account-kit:doctor', appUrl ? [`--app-url=${appUrl}`] : [])
      assert.equal(failing.exitCode, 1)
      assert.deepEqual(errors, ['APP_URL: is not set. Pass --app-url with the public base URL'])
      assert.lengthOf(infos, passingInfoCount)
    } finally {
      kit.app.config.set('account_kit', undefined)
    }
  })
})

for (const environment of ['development', 'production'] as const) {
  test.group(`doctor APP_URL checks in ${environment}`, (group) => {
    group.setup(() => {
      const previous = process.env.NODE_ENV
      process.env.NODE_ENV = environment
      return () => {
        if (previous === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previous
      }
    })
    const kit = useTestApp(group, { accountKitProvider: 'source' })

    test('the Ace command checks the effective backend origin when action URLs configure it', async ({
      assert,
    }) => {
      let appUrl: string | undefined
      const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
      const { kernel } = aceKernel(kit, [AccountKitDoctor])
      const successes: string[] = []
      const errors: string[] = []
      kernel.ui.logger.success = (message) => {
        successes.push(message)
      }
      kernel.ui.logger.error = (message) => {
        errors.push(String(message))
      }
      const options = {
        backendOrigin: 'https://api.example.test/v1',
        appFrontendUrl: 'https://web.example.test',
        destinations: { passwordReset: 'reset-password' },
        environment: 'development',
      } as const
      try {
        appUrl = undefined
        for (const setting of ['PUBLIC_API_URL', undefined]) {
          kit.app.config.set(
            'account_kit',
            defineConfig({
              ...base,
              urls: createActionUrls({ ...options, backendOriginSetting: setting }),
            })
          )
          const command = await kernel.exec(
            'account-kit:doctor',
            appUrl ? [`--app-url=${appUrl}`] : []
          )
          assert.equal(command.exitCode, 0)
          assert.include(successes, `${setting ?? 'urls.backendOrigin'}: https://api.example.test`)
          assert.deepEqual(errors, [])
        }
        appUrl = options.backendOrigin
        const conventional = await kernel.exec(
          'account-kit:doctor',
          appUrl ? [`--app-url=${appUrl}`] : []
        )
        assert.equal(conventional.exitCode, 0)
        assert.include(successes, 'APP_URL: https://api.example.test')
        if (environment === 'production') {
          const urls = createActionUrls({
            ...options,
            backendOrigin: 'http://localhost:3333',
            backendOriginSetting: 'PUBLIC_API_URL',
          })
          kit.app.config.set('account_kit', defineConfig({ ...base, urls }))
          appUrl = 'https://example.test'
          const command = await kernel.exec(
            'account-kit:doctor',
            appUrl ? [`--app-url=${appUrl}`] : []
          )
          assert.equal(command.exitCode, 1)
          assert.deepEqual(errors, [
            'PUBLIC_API_URL: must use HTTPS in production. Use an https:// URL',
          ])
        }
      } finally {
        kit.app.config.set('account_kit', undefined)
      }
    })

    test('the Ace command applies trusted-origin rules without exercising callbacks', async ({
      assert,
    }) => {
      assert.equal(kit.app.nodeEnvironment, environment)
      let appUrl: string | undefined
      const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
      let callbackCalls = 0
      kit.app.config.set(
        'account_kit',
        defineConfig({
          ...base,
          urls: {
            ...base.urls,
            passwordReset: () => {
              callbackCalls++
              return 'https://custom.example.test/recovery'
            },
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
        for (const [url, expected] of [
          ['https://accounts.example.test/portal', null],
          [
            'http://localhost:3333/portal',
            environment === 'production' ? 'must use HTTPS in production' : null,
          ],
          [
            'http://127.0.0.1:3333/portal',
            environment === 'production' ? 'must use HTTPS in production' : null,
          ],
          [
            'http://[::1]:3333/portal',
            environment === 'production' ? 'must use HTTPS in production' : null,
          ],
          [
            'http://accounts.example.test/portal',
            environment === 'production'
              ? 'must use HTTPS in production'
              : 'HTTP is restricted to loopback development origins',
          ],
          [
            'https://person:private-secret@accounts.example.test/portal',
            'invalid configured origin',
          ],
          ['https://accounts.example.test/portal?mode=private-query', 'invalid configured origin'],
          ['https://accounts.example.test/portal#private-fragment', 'invalid configured origin'],
        ] as const) {
          successes.length = 0
          errors.length = 0
          infos.length = 0
          appUrl = url
          const command = await kernel.exec(
            'account-kit:doctor',
            appUrl ? [`--app-url=${appUrl}`] : []
          )
          assert.equal(command.exitCode, expected === null ? 0 : 1)
          if (expected === null) {
            assert.deepEqual(errors, [])
            assert.include(successes, `APP_URL: ${new URL(url).origin}`)
            assert.isTrue(
              infos.some((message) =>
                message.startsWith('Unverified: notification callbacks and delivery')
              )
            )
          } else {
            assert.lengthOf(errors, 1)
            assert.match(errors[0], new RegExp(`^APP_URL: ${expected}`))
            assert.isFalse(successes.some((message) => message.startsWith('APP_URL:')))
            assert.deepEqual(infos, [])
            for (const secret of ['private-secret', 'person:', 'private-query', 'private-fragment'])
              assert.notInclude(errors.join(' '), secret)
          }
        }
        assert.equal(callbackCalls, 0)
        assert.isTrue(AccountKitDoctor.options.startApp)
      } finally {
        kit.app.config.set('account_kit', undefined)
      }
    })
  })
}
