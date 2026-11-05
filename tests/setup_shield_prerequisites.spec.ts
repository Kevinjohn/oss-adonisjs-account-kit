import { test } from '@japa/runner'
import { planSetup } from '../src/setup/plan.js'
import { withFixture } from './helpers/setup_prerequisites.js'

test.group('setup shield prerequisites', () => {
  test('comments do not certify Shield and empty Limiter configuration fails', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/shield.ts'] =
        '/* csrf: { enabled: true } */ export default { csrf: { enabled: process.env.CSRF === "on" } }'
      state.files['config/limiter.ts'] = 'export default defineConfig({})'
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/shield.ts' && severity === 'action'
        )
      )
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nexport default defineConfig({ default: 'database', stores: { memory: stores.memory({}) } })"
      const wrongStore = await planSetup(choices, state)
      assert.isTrue(
        wrongStore.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nconst example = `default: 'memory', stores: { memory: stores.memory({}) }`\nexport default defineConfig({})"
      const quoted = await planSetup(choices, state)
      assert.isTrue(
        quoted.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/limiter'\nexport default defineConfig({ default: env.get('LIMITER_STORE'), stores: { memory: stores.memory({}) } })"
      const prior = process.env.LIMITER_STORE
      delete process.env.LIMITER_STORE
      try {
        const unresolved = await planSetup(choices, state)
        assert.isTrue(
          unresolved.diagnostics.some(
            ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
          )
        )
      } finally {
        if (prior === undefined) delete process.env.LIMITER_STORE
        else process.env.LIMITER_STORE = prior
      }
    })
  })

  test('session CSRF guidance uses selected path or application-owned bootstrap', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      const inert = await planSetup(choices, state)
      assert.isTrue(
        inert.prerequisites.some((item) => item.includes('application-owned CSRF bootstrap'))
      )
      assert.isFalse(inert.prerequisites.some((item) => item.includes('GET /account/auth/csrf')))

      choices.authentication!.applicationRouteRevocation = true
      const standard = await planSetup(choices, state)
      assert.isTrue(standard.prerequisites.some((item) => item.includes('GET /account/auth/csrf')))
      choices.managedExcept = ['auth.csrf']
      const excluded = await planSetup(choices, state)
      assert.isTrue(
        excluded.prerequisites.some((item) => item.includes('application-owned CSRF bootstrap'))
      )
      assert.isFalse(excluded.prerequisites.some((item) => item.includes('GET /account/auth/csrf')))
    })
  })

  test('escaped Shield keys cannot override inspected CSRF state', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['config/shield.ts'] =
        String.raw`export default { csrf: { enabled: true, '\u0065nabled': false } }`
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/shield.ts' && severity === 'error'
        )
      )
    })
  })

  test('local Shield wrapper cannot attest CSRF without the framework import', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/shield.ts'] =
        'const __unbound_define_config__ = (config: any) => ({ csrf: { enabled: false } })\nexport default __unbound_define_config__({ csrf: { enabled: true } })'
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/shield.ts' && severity === 'error'
        )
      )
    })
  })
})
