import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { pathToFileURL } from 'node:url'
import SetupAccountKit from '../commands/setup.js'
import { inspectSetup } from '../src/setup/inspect.js'
import { fixture, registerSetupTeardown, retirementIgnitor } from './helpers/setup.js'

test.group('onboarding plan and apply', (group) => {
  registerSetupTeardown(group)

  test('noninteractive Ace preview and apply use the same choices without prompting', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const input = join(root, 'choices.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [],
          commands: [async () => new ListLoader([SetupAccountKit])],
        },
      })
      .create(pathToFileURL(`${root}/`))
    await ignitor.ace().handle(['account-kit:setup', `--input=${input}`])
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    await ignitor.ace().handle(['account-kit:setup', `--input=${input}`, '--apply'])
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'config/account_kit_setup.json'), 'utf8')),
      choices
    )
  })

  test('Ace reconfiguration obtains its retirement count before writing and fails closed on affected accounts', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const oldChoices = structuredClone(choices)
    oldChoices.features.push('authentication')
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(oldChoices)}\n`)
    choices.authentication = null
    choices.managed = []
    const input = join(root, 'retire.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    const ignitor = retirementIgnitor(root, async () => ({
      inspectedAccounts: 2,
      affectedAccounts: 1,
      checkedAt: new Date().toISOString(),
    }))
    const previousExitCode = process.exitCode
    try {
      await ignitor
        .ace()
        .handle([
          'account-kit:setup',
          `--input=${input}`,
          '--apply',
          '--retirement-maintenance-window',
        ])
    } finally {
      process.exitCode = previousExitCode
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'config/account_kit_setup.json'), 'utf8')),
      oldChoices
    )
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit.ts')
  })

  test('Ace retirement fails closed when its read-only inventory cannot query', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(choices)}\n`)
    choices.authentication = null
    choices.managed = []
    const input = join(root, 'retire.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    const ignitor = retirementIgnitor(root, async () => {
      throw new Error('database unavailable')
    })
    const previousExitCode = process.exitCode
    try {
      await ignitor
        .ace()
        .handle([
          'account-kit:setup',
          `--input=${input}`,
          '--apply',
          '--retirement-maintenance-window',
        ])
    } finally {
      process.exitCode = previousExitCode
    }
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit.ts')
    const state = await inspectSetup(root)
    assert.isNotNull(state.existingChoices?.authentication)
  })

  test('Ace retirement applies after a zero-impact inventory in a maintenance window', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(choices)}\n`)
    choices.authentication = null
    choices.managed = []
    const input = join(root, 'retire.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    const ignitor = retirementIgnitor(root, async () => ({
      inspectedAccounts: 2,
      affectedAccounts: 0,
      checkedAt: new Date().toISOString(),
    }))
    await ignitor
      .ace()
      .handle([
        'account-kit:setup',
        `--input=${input}`,
        '--apply',
        '--retirement-maintenance-window',
      ])
    const state = await inspectSetup(root)
    assert.isNull(state.existingChoices?.authentication)
    assert.include(await readdir(join(root, 'config')), 'account_kit.ts')
  })

  test('Ace inventory sees runtime provider drift before writing unchanged social choices', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('socialAuthentication')
    choices.social = {
      status: 'enabled',
      providers: ['google'],
      callbackOriginEnv: 'APP_URL',
      callbackPath: '/account/auth/oauth/{provider}/callback',
      credentials: {
        google: { clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET' },
      },
    }
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(choices)}\n`)
    const input = join(root, 'same-social.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    let proposed: unknown
    const ignitor = retirementIgnitor(root, async (value) => {
      proposed = value
      return {
        inspectedAccounts: 2,
        affectedAccounts: 1,
        checkedAt: new Date().toISOString(),
        currentProviders: ['google', 'github'],
        currentPasswordLogin: true,
      }
    })
    const previousExitCode = process.exitCode
    try {
      await ignitor.ace().handle(['account-kit:setup', `--input=${input}`, '--apply'])
    } finally {
      process.exitCode = previousExitCode
    }
    assert.deepEqual(proposed, { passwordLogin: true, providers: ['google'] })
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit.ts')
  })

  test('Ace passes an explicit empty remaining-provider set when retiring all social providers', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const oldChoices = structuredClone(choices)
    oldChoices.features.push('socialAuthentication')
    oldChoices.social = {
      status: 'enabled',
      providers: ['google', 'github'],
      callbackOriginEnv: 'APP_URL',
      callbackPath: '/account/auth/oauth/{provider}/callback',
      credentials: {
        google: { clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET' },
        github: { clientIdEnv: 'GITHUB_CLIENT_ID', clientSecretEnv: 'GITHUB_CLIENT_SECRET' },
      },
    }
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(oldChoices)}\n`)
    const input = join(root, 'retire-social.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    let proposed: unknown
    const ignitor = retirementIgnitor(root, async (value) => {
      proposed = value
      return {
        inspectedAccounts: 1,
        affectedAccounts: 1,
        checkedAt: new Date().toISOString(),
        currentProviders: ['google', 'github'],
        currentPasswordLogin: true,
      }
    })
    const previousExitCode = process.exitCode
    try {
      await ignitor.ace().handle(['account-kit:setup', `--input=${input}`, '--apply'])
    } finally {
      process.exitCode = previousExitCode
    }
    assert.deepEqual(proposed, { passwordLogin: true, providers: [] })
    const state = await inspectSetup(root)
    assert.deepEqual(state.existingChoices, oldChoices)
  })

  if (process.env.TEST_BUILT_SETUP === '1') {
    test('built Ace command previews and applies packaged migration templates', async ({
      assert,
    }) => {
      const builtPath = '../build/commands/setup.js'
      const { default: BuiltSetup } = (await import(builtPath)) as {
        default: typeof SetupAccountKit
      }
      const { root, choices } = await fixture()
      const input = join(root, 'choices.json')
      await writeFile(input, JSON.stringify(choices))
      const ignitor = new IgnitorFactory()
        .withCoreProviders()
        .withCoreConfig()
        .merge({
          rcFileContents: { providers: [], commands: [async () => new ListLoader([BuiltSetup])] },
        })
        .create(pathToFileURL(`${root}/`))
      await ignitor.ace().handle(['account-kit:setup', `--input=${input}`])
      await ignitor.ace().handle(['account-kit:setup', `--input=${input}`, '--apply'])
      const migrations = await readdir(join(root, 'database/migrations'))
      assert.isAbove(migrations.filter((name) => name.includes('_account_kit_')).length, 0)
      assert.deepEqual(
        JSON.parse(await readFile(join(root, 'config/account_kit_setup.json'), 'utf8')),
        choices
      )
    })
  }
})
