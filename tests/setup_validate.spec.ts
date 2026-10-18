import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import SetupAccountKit from '../commands/setup.js'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { parseSetupChoices } from '../src/setup/parse.js'
import { fixture, registerSetupTeardown } from './helpers/setup.js'

test.group('setup choice validation', (group) => {
  registerSetupTeardown(group)

  test('standard defaults require explicit invitation and social opt-in', ({ assert }) => {
    const choices = defaultSetupChoices()
    assert.notInclude(choices.features, 'invitations')
    assert.notInclude(choices.managed, 'invitations')
    assert.equal(choices.social.status, 'not-applicable')
    assert.equal(choices.mail.integration, 'adonisjs-mail')
  })

  test('interactive token answers produce complete parseable choices including invitation destination', async ({
    assert,
  }) => {
    const answers: Record<string, string> = {
      'Enabled services': 'authentication,invitations',
      'Managed endpoint groups': 'authentication,invitations',
      'Managed endpoint exclusions': 'auth.invitation.inspect',
      'Existing guard strategy': 'access_tokens',
      'Existing guard name': 'api',
      'Token revocation': 'yes',
      'Application-owned protected': 'yes',
      'Delivery integration': 'custom',
      'invitation relative': 'invites/accept',
      'Additional registration fields': '[{"name":"fullName","type":"string","required":true}]',
      'Application invitation permission': 'yes',
    }
    const choices = await SetupAccountKit.prototype.interactiveChoices.call(
      { logger: { info() {} } } as unknown as SetupAccountKit,
      async (question) =>
        Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1] ?? ''
    )
    assert.equal(choices.authentication?.strategy, 'access_tokens')
    assert.deepEqual(choices.managedExcept, ['auth.invitation.inspect'])
    assert.isFalse(Object.hasOwn(choices.authentication!, 'session'))
    assert.equal(choices.mail.destinations.invitation, 'invites/accept')
    assert.lengthOf(choices.policy.registrationFields, 1)
    assert.deepEqual(parseSetupChoices(choices), choices)
  })

  test('magic-link sign-in asks for its destination and generates its config and routes', async ({
    assert,
  }) => {
    const answers: Record<string, string> = {
      'Enabled services': 'authentication,magicLinkLogin',
      'Managed endpoint groups': 'authentication,magicLinkLogin',
      'Existing guard strategy': 'access_tokens',
      'Existing guard name': 'api',
      'Token revocation': 'yes',
      'Application-owned protected': 'yes',
      'Delivery integration': 'custom',
      'magicLink relative': 'login/link',
    }
    const asked = await SetupAccountKit.prototype.interactiveChoices.call(
      { logger: { info() {} } } as unknown as SetupAccountKit,
      async (question) =>
        Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1] ?? ''
    )
    assert.equal(asked.mail.destinations.magicLink, 'login/link')
    assert.deepEqual(parseSetupChoices(asked), asked)

    const { root, choices } = await fixture()
    choices.features.push('magicLinkLogin')
    choices.managed.push('magicLinkLogin')
    choices.mail.destinations.magicLink = 'account/magic-link'
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content!
    assert.include(config, '"magicLinkLogin"')
    assert.include(config, '"magicLink":"account/magic-link"')
    const routes = plan.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content!
    assert.include(routes, '"magicLinkLogin"')

    delete choices.mail.destinations.magicLink
    choices.authentication = null
    const blocked = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.includeMembers(
      blocked.diagnostics.map(({ field, message }) => `${field}: ${message}`),
      [
        'authentication: Magic-link sign-in requires a selected existing guard',
        'mail.destinations.magicLink: Enabled email flow needs a relative frontend destination',
      ]
    )
  })

  test('session management generates its config and routes and requires a guard', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('sessionManagement')
    choices.managed.push('sessionManagement')
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content!
    assert.include(config, '"sessionManagement"')
    const routes = plan.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content!
    assert.include(routes, '"sessionManagement"')

    choices.authentication = null
    const blocked = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      blocked.diagnostics.map(({ field, message }) => `${field}: ${message}`),
      'authentication: Session management requires a selected existing guard'
    )
  })

  test('interactive provider selection does not duplicate an already selected social group', async ({
    assert,
  }) => {
    const answers: Record<string, string> = {
      'Enabled services':
        'authentication,registration,emailVerification,passwordReset,socialAuthentication',
      'Managed endpoint groups': 'authentication,socialAuthentication',
      'Existing guard strategy': 'access_tokens',
      'Existing guard name': 'api',
      'Token revocation': 'yes',
      'Application-owned protected': 'yes',
      'Delivery integration': 'custom',
      'Application restricted-account': 'yes',
      'Social providers to prepare': 'google',
    }
    const choices = await SetupAccountKit.prototype.interactiveChoices.call(
      { logger: { info() {} } } as unknown as SetupAccountKit,
      async (question) =>
        Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1] ?? ''
    )
    assert.equal(choices.features.filter((name) => name === 'socialAuthentication').length, 1)
    assert.equal(choices.managed.filter((name) => name === 'socialAuthentication').length, 1)
    assert.doesNotThrow(() => parseSetupChoices(choices))
  })

  test('application-admitted registration cannot expose the managed public signup route', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('registration')
    choices.managed.push('registration')
    choices.policy.registration = 'application'
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      'policy.registration'
    )
    await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
  })

  test('unresolved database selection blocks apply before any write', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      "import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nconst other = await import('#start/env')\nother.default.get = () => 'mysql'\nexport default defineConfig({ connection: env.get('DB_CONNECTION', 'sqlite'), connections: { sqlite: { client: 'better-sqlite3' }, mysql: { client: 'mysql2' } } })"
    )
    const state = await inspectSetup(root)
    assert.equal(state.database, 'unknown')
    const before = await readdir(root)
    const plan = await planSetup(choices, state, { apply: true, timestamp: 1234 })
    assert.isTrue(
      plan.diagnostics.some(
        ({ field, severity }) => field === 'database.client' && severity === 'error'
      )
    )
    await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
    assert.deepEqual(await readdir(root), before)
  })

  test('blocks unsupported guard, topology, password bounds and login retirement', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.managed.push('authentication')
    choices.features.push('authentication')
    choices.authentication = {
      strategy: 'session',
      guard: 'missing',
      session: { secureCookie: false, csrf: false, originChecked: false, persistentStore: false },
      applicationRouteRevocation: false,
    }
    choices.policy.password.minLength = 257
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.includeMembers(
      plan.diagnostics.map(({ field }) => field),
      ['authentication.guard', 'authentication.applicationRouteRevocation', 'policy.password']
    )
    await assert.rejects(() => applySetup(root, plan), /Setup has blocking diagnostics/)
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(choices)}\n`)
    choices.features = ['passwordReset']
    choices.managed = []
    choices.authentication = null
    const retirement = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      retirement.diagnostics.map(({ field }) => field),
      'authentication.retirement'
    )
  })

  test('rejects insecure production origins without disclosing their values', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const previousApp = process.env.APP_URL
    const previousFrontend = process.env.FRONTEND_URL
    process.env.APP_URL = 'http://account.example.test/root/'
    process.env.FRONTEND_URL = 'http://account.example.test/'
    try {
      const plan = await planSetup(choices, await inspectSetup(root), { production: true })
      assert.includeMembers(
        plan.diagnostics.map(({ field }) => field),
        ['mail.backendOriginEnv', 'mail.frontendOriginEnv']
      )
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'mail.frontendOriginEnv' && severity === 'error' && /HTTPS/i.test(message)
        )
      )
      assert.notInclude(JSON.stringify(plan.diagnostics), 'account.example.test')
      assert.isFalse(plan.readiness.productionReady)
    } finally {
      if (previousApp === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previousApp
      if (previousFrontend === undefined) delete process.env.FRONTEND_URL
      else process.env.FRONTEND_URL = previousFrontend
    }
  })

  test('stops on an existing managed prefix and rejects hidden JSON fields', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'start/routes.ts'),
      "import router from '@adonisjs/core/services/router'\nrouter.post('/account/auth/password-reset', handler)\n"
    )
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      'routePrefix'
    )
    await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
    assert.throws(
      () => parseSetupChoices({ ...choices, privateApiKey: 'must-never-persist' }),
      /privateApiKey: unsupported field/
    )
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
  })

  test('semantic setup choices reject invalid registration, duration and abilities', ({
    assert,
  }) => {
    const choices = defaultSetupChoices()
    choices.policy.registration = 'typo' as never
    assert.throws(() => parseSetupChoices(choices), /policy.registration/)
    choices.policy.registration = 'open'
    choices.authentication = {
      strategy: 'access_tokens',
      guard: 'api',
      token: { revocation: true, lifetime: 'nonsense', abilities: ['*'] },
      applicationRouteRevocation: true,
    }
    assert.throws(() => parseSetupChoices(choices), /authentication.token.lifetime/)
    choices.authentication.token!.lifetime = '7d'
    choices.authentication.token!.abilities = ['']
    assert.throws(() => parseSetupChoices(choices), /authentication.token.abilities/)
  })

  test('additional registration fields are explicit and protected properties are refused', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('registration')
    choices.policy.registration = 'open'
    choices.policy.registrationFields = [
      { name: 'fullName', type: 'string', required: true, maxLength: 120 },
    ]
    const plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content
    assert.include(config, 'mapFields: mapRegistrationFields')
    assert.include(config, 'mapRegistrationData: (data, user)')
    assert.include(config, 'registrationData.${key} is not allowed')
    assert.include(config, "import { InvalidInputError } from 'adonisjs-account-kit/errors'")
    assert.include(
      config,
      'throw new InvalidInputError(`account_kit: registrationData.${field.name} is required`)'
    )
    choices.policy.registrationFields.push({ name: 'Role', type: 'string', required: true })
    const blocked = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      blocked.diagnostics.map(({ field }) => field),
      'policy.registrationFields.1.name'
    )
    await assert.rejects(() => applySetup(root, blocked), /blocking diagnostics/)
  })
})
