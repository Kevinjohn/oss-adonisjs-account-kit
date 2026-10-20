import { readdir } from 'node:fs/promises'
import { test } from '@japa/runner'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { withFixture } from './helpers/setup_prerequisites.js'

test.group('setup mail prerequisites', () => {
  test('maintained Mail validates brand and sender without leaking values', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      choices.mail.integration = 'adonisjs-mail'
      choices.mail.appName = 'Brand\r\nInjected'
      state.files['config/mail.ts'] = 'export default defineConfig({ mailers: {} })'
      const prior = process.env.ACCOUNT_MAIL_FROM
      process.env.ACCOUNT_MAIL_FROM = 'person@example.test\nInjected'
      try {
        const plan = await planSetup(choices, state)
        assert.include(
          plan.diagnostics.map(({ field }) => field),
          'mail.appName'
        )
        assert.include(
          plan.diagnostics.map(({ field }) => field),
          'mail.senderEnv'
        )
        assert.isFalse(JSON.stringify(plan.diagnostics).includes('person@example.test'))
        process.env.ACCOUNT_MAIL_FROM = '   '
        const blank = await planSetup(choices, state)
        assert.isTrue(
          blank.diagnostics.some(
            ({ field, severity }) => field === 'mail.senderEnv' && severity === 'error'
          )
        )
      } finally {
        if (prior === undefined) delete process.env.ACCOUNT_MAIL_FROM
        else process.env.ACCOUNT_MAIL_FROM = prior
      }
    })
  })

  test('maintained Mail requires a selected mailer and remains unverified statically', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.mail.integration = 'adonisjs-mail'
      choices.mail.transportEnv = 'MAIL_MAILER'
      const previous = process.env.MAIL_MAILER
      process.env.MAIL_MAILER = 'smtp'
      try {
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nexport default defineConfig({ default: env.get('MAIL_MAILER'), mailers: {} })"
        const empty = await planSetup(choices, state)
        assert.isTrue(
          empty.diagnostics.some(
            ({ field, severity }) => field === 'config/mail.ts' && severity === 'error'
          )
        )
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nexport default defineConfig({ default: env.get('MAIL_MAILER'), mailers: { other: customTransport() } })"
        const wrong = await planSetup(choices, state)
        assert.isTrue(
          wrong.diagnostics.some(
            ({ field, severity }) => field === 'config/mail.ts' && severity === 'error'
          )
        )
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nexport default defineConfig({ default: env.get('MAIL_MAILER'), mailers: { smtp: customTransport() } })"
        const selected = await planSetup(choices, state)
        assert.isTrue(
          selected.diagnostics.some(
            ({ field, severity }) => field === 'config/mail.ts' && severity === 'action'
          )
        )
        assert.isFalse(selected.readiness.externalConfigured)
      } finally {
        if (previous === undefined) delete process.env.MAIL_MAILER
        else process.env.MAIL_MAILER = previous
      }
    })
  })

  test('maintained Mail rejects nullish selected values and ambiguous environment imports', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.mail.integration = 'adonisjs-mail'
      choices.mail.transportEnv = 'MAIL_MAILER'
      const previous = process.env.MAIL_MAILER
      process.env.MAIL_MAILER = 'smtp'
      try {
        for (const value of [
          'null',
          'undefined',
          'void 0',
          '(null as unknown)',
          'null!',
          'undefined!',
          'false',
          '42',
          "'smtp'",
          '[]',
          '{}',
          '({} satisfies object)',
          '(/smtp/ as unknown)',
          '<any>null',
          '(<unknown>null)!',
          '<any>(null as unknown)',
          '(<any>undefined)!',
          '<any>false',
          '<any>({})',
        ]) {
          state.files['config/mail.ts'] =
            `import { defineConfig } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: ${value} } })`
          const invalid = await planSetup(choices, state)
          assert.isTrue(
            invalid.diagnostics.some(
              ({ field, severity, message }) =>
                field === 'config/mail.ts' &&
                severity === 'error' &&
                message.includes('callable transport provider')
            )
          )
          assert.isFalse(invalid.readiness.configurationValid)
        }
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nimport * as envModule from '#start/env'\nenvModule.default.get = () => 'other'\nexport default defineConfig({ default: env.get('MAIL_MAILER', 'smtp'), mailers: { smtp: customTransport() } })"
        const ambiguous = await planSetup(choices, state)
        assert.isTrue(
          ambiguous.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/mail.ts' && severity === 'error' && message.includes('provenance')
          )
        )
        assert.isFalse(ambiguous.readiness.externalConfigured)
        state.files['config/mail.ts'] =
          "import { defineConfig, transports } from '@adonisjs/mail'\nimport env from '#start/env'\nconst other = await import('#start/env')\nother.default.get = () => 'other'\nexport default defineConfig({ default: env.get('MAIL_MAILER', 'smtp'), mailers: { smtp: transports.smtp({}) } })"
        const dynamicEnv = await planSetup(choices, state)
        assert.isTrue(
          dynamicEnv.diagnostics.some(
            ({ field, severity }) => field === 'config/mail.ts' && severity === 'error'
          )
        )
        state.files['config/mail.ts'] =
          "import { defineConfig, transports } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: transports.smtp({}) } })"
        const native = await planSetup(choices, state)
        assert.isTrue(
          native.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/mail.ts' &&
              severity === 'action' &&
              message.includes('Verify the selected')
          )
        )
        assert.isFalse(native.readiness.externalConfigured)
        state.files['config/mail.ts'] =
          "import { defineConfig as mailConfig, transports as mailTransport } from '@adonisjs/mail'\nexport default mailConfig({ default: 'smtp', mailers: { smtp: mailTransport.smtp({}) } })"
        const aliasedNative = await planSetup(choices, state)
        assert.isTrue(
          aliasedNative.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/mail.ts' &&
              severity === 'action' &&
              message.includes('Verify the selected')
          )
        )
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: (<any>(() => ({})))! } })"
        const callable = await planSetup(choices, state)
        assert.isTrue(
          callable.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/mail.ts' &&
              severity === 'action' &&
              message.includes('Verify the selected')
          )
        )
      } finally {
        if (previous === undefined) delete process.env.MAIL_MAILER
        else process.env.MAIL_MAILER = previous
      }
    })
  }).timeout(10_000)

  test('unsafe Mail configuration blocks apply without writing files', async ({ assert }) => {
    await withFixture(async (choices, state, root) => {
      choices.mail.integration = 'adonisjs-mail'
      choices.mail.transportEnv = 'MAIL_MAILER'
      const previous = process.env.MAIL_MAILER
      process.env.MAIL_MAILER = 'smtp'
      const cases = [
        "import { defineConfig } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: <any>null } })",
        "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nenv.get = () => 'missing'\nexport default defineConfig({ default: env.get('MAIL_MAILER', 'smtp'), mailers: { smtp: () => ({}) } })",
        "import { defineConfig, transports } from '@adonisjs/mail'\ntransports.smtp = () => null\nexport default defineConfig({ default: 'smtp', mailers: { smtp: transports.smtp({}) } })",
        "import { defineConfig, transports } from '@adonisjs/mail'\nconst config = defineConfig({ default: 'smtp', mailers: { smtp: transports.smtp({}) } })\nconfig.mailers.smtp = null\nexport default config",
        "import { defineConfig } from '@adonisjs/mail'\nconst selected = 'smtp'\nexport default defineConfig({ default: selected, mailers: { smtp: () => ({}) } })",
        "import { defineConfig } from '@adonisjs/mail'\nexport default customConfig({ default: 'smtp', mailers: { smtp: () => ({}) } })",
        "import { defineConfig, transports } from '@adonisjs/mail'\nimport env from '#start/env'\nenv.get = () => 'missing'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: transports.smtp({ host: env.get('MAIL_HOST') }) } })",
        "import { defineConfig } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: false ? () => ({}) : () => ({}) } })",
        "import { defineConfig, transports } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: transports.unknown({}) } })",
      ]
      try {
        for (const mail of cases) {
          state.files['config/mail.ts'] = mail
          const before = await readdir(root)
          const plan = await planSetup(choices, state, { apply: true })
          assert.isTrue(
            plan.diagnostics.some(
              ({ field, severity }) => field === 'config/mail.ts' && severity === 'error'
            ),
            mail
          )
          await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
          assert.deepEqual(await readdir(root), before)
        }
      } finally {
        if (previous === undefined) delete process.env.MAIL_MAILER
        else process.env.MAIL_MAILER = previous
      }
    })
  })

  test('authentication-only service setup leaves email delivery not applicable', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.mode = 'services'
      choices.features = ['authentication']
      choices.managed = []
      choices.policy.registration = 'closed'
      choices.policy.verificationRequired = false
      choices.authentication!.applicationRouteRevocation = true
      delete state.files['config/mail.ts']
      delete state.files['app/services/account_kit_notifications.ts']
      state.installedPackages = state.installedPackages.filter((name) => name !== '@adonisjs/mail')
      delete state.installedVersions['@adonisjs/mail']
      const plan = await planSetup(choices, state)
      const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content
      assert.equal(plan.pillars.mail, 'not applicable: no email capability selected')
      assert.equal(plan.readiness.delivery, 'not applicable')
      assert.notInclude(config, 'createActionUrls')
      assert.notInclude(config, 'accountKitNotifications')
      assert.notInclude(config, 'createMailNotifications')
      assert.include(config, '  urls: {},')
      assert.include(config, '  notify: {},')
      assert.isFalse(
        plan.diagnostics.some(
          ({ field }) =>
            field.startsWith('mail.') ||
            field === 'config/mail.ts' ||
            field === 'dependencies.@adonisjs/mail'
        )
      )
      assert.notInclude(
        plan.changes.find(({ path }) => path === 'adonisrc.ts')?.content ?? '',
        '@adonisjs/mail/mail_provider'
      )
      assert.notInclude(
        plan.changes.find(({ path }) => path === '.env.account-kit.example')!.content,
        choices.mail.frontendOriginEnv
      )
    })
  })

  test('callback files alone do not certify external configuration', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      const plan = await planSetup(choices, state)
      assert.include(
        plan.diagnostics.map(({ field }) => field),
        'policy.callbacks'
      )
      assert.include(
        plan.diagnostics.map(({ field }) => field),
        'mail.callbacks'
      )
      assert.isFalse(plan.readiness.externalConfigured)
    })
  })
})
