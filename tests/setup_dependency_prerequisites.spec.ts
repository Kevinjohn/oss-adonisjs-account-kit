import { test } from '@japa/runner'
import { planSetup } from '../src/setup/plan.js'
import { withFixture } from './helpers/setup_prerequisites.js'

test.group('setup dependency prerequisites', () => {
  test('setup requires an explicitly installed supported TypeScript parser', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      delete state.installedVersions.typescript
      state.installedPackages = state.installedPackages.filter((name) => name !== 'typescript')
      const missing = await planSetup(choices, state)
      assert.isTrue(
        missing.diagnostics.some(
          ({ field, severity }) => field === 'dependencies.typescript' && severity === 'error'
        )
      )
      state.installedPackages.push('typescript')
      state.installedVersions.typescript = '5.8.0'
      const old = await planSetup(choices, state)
      assert.isTrue(
        old.diagnostics.some(
          ({ field, severity }) => field === 'dependencies.typescript' && severity === 'error'
        )
      )
      state.installedVersions.typescript = '6.0.3'
      const supported = await planSetup(choices, state)
      assert.isFalse(
        supported.diagnostics.some(
          ({ field, severity }) => field === 'dependencies.typescript' && severity === 'error'
        )
      )
    })
  })

  test('service-only proposal does not register Vine or require its package', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.mode = 'services'
      choices.managed = []
      choices.features = ['passwordReset']
      choices.authentication = null
      choices.policy.accessRestrictionHook = false
      state.installedPackages = state.installedPackages.filter((name) => name !== '@vinejs/vine')
      delete state.installedVersions['@vinejs/vine']
      const plan = await planSetup(choices, state)
      assert.notInclude(
        plan.diagnostics.map(({ field }) => field),
        'dependencies.@vinejs/vine'
      )
      assert.notInclude(
        plan.changes.find(({ path }) => path === 'adonisrc.ts')?.content ?? '',
        'vinejs_provider'
      )
    })
  })

  test('checks selected package minima and maintained destination rules', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.installedVersions['@adonisjs/lucid'] = '22.0.0'
      state.installedVersions['@vinejs/vine'] = '4.0.0'
      state.installedVersions['@adonisjs/mail'] = '9.0.0'
      choices.mail.destinations.passwordReset = '%2e%2e/reset'
      choices.mail.destinations.emailVerification = ' account/verify '
      const plan = await planSetup(choices, state)
      const fields = plan.diagnostics.map(({ field }) => field)
      assert.include(fields, 'dependencies.@adonisjs/lucid')
      assert.include(fields, 'dependencies.@vinejs/vine')
      assert.notInclude(fields, 'dependencies.@adonisjs/mail')
      assert.include(fields, 'mail.destinations.passwordReset')
      assert.include(fields, 'mail.destinations.emailVerification')
    })
  })
})
