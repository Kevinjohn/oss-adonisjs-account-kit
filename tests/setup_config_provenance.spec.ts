import { test } from '@japa/runner'
import { planSetup } from '../src/setup/plan.js'
import { withFixture } from './helpers/setup_prerequisites.js'

test.group('setup config provenance', () => {
  test('mutated Limiter and environment bindings cannot certify selected factories', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nstores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const mutatedFactory = await planSetup(choices, state)
      assert.isTrue(
        mutatedFactory.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/limiter'\nenv.get = () => 'unknown'\nexport default defineConfig({ default: env.get('LIMITER_STORE', 'memory'), stores: { memory: stores.memory({}) } })"
      const mutatedEnv = await planSetup(choices, state)
      assert.isTrue(
        mutatedEnv.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/session.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nenv.get = () => 'cookie'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER', 'database'), stores: { database: stores.database() } })\nexport default sessionConfig"
      const mutatedSession = await planSetup(choices, state)
      assert.isTrue(
        mutatedSession.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
    })
  })

  test('additional runtime module imports invalidate session and Limiter provenance', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "import env from '#start/env'\nimport * as envModule from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nenvModule.default.get = () => 'cookie'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER', 'database'), stores: { database: stores.database() } })\nexport default sessionConfig"
      const session = await planSetup(choices, state)
      assert.isTrue(
        session.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nimport * as limiter from '@adonisjs/limiter'\nlimiter.stores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const limiter = await planSetup(choices, state)
      assert.isTrue(
        limiter.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import env from '#start/env'\nimport { default as otherEnv } from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/limiter'\notherEnv.get = () => 'unknown'\nexport default defineConfig({ default: env.get('LIMITER_STORE', 'memory'), stores: { memory: stores.memory({}) } })"
      const limiterEnv = await planSetup(choices, state)
      assert.isTrue(
        limiterEnv.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
    })
  })

  test('dynamic module views cannot certify selected session and Limiter factories', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst other = await import(`#start/env`)\nother.default.get = () => 'cookie'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER', 'database'), stores: { database: stores.database() } })\nexport default sessionConfig"
      const session = await planSetup(choices, state)
      assert.isTrue(
        session.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
      state.files['config/session.ts'] =
        "import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'database', stores: { database: stores.database() } })\nexport default sessionConfig"
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nconst other = await import('@adonisjs/limiter')\nother.stores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const limiter = await planSetup(choices, state)
      assert.isTrue(
        limiter.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nconst moduleName = '@adonisjs/limiter'\nconst other = await import(moduleName)\nother.stores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const computed = await planSetup(choices, state)
      assert.isTrue(
        computed.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nconst other = require('@adonisjs/limiter')\nother.stores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const required = await planSetup(choices, state)
      assert.isTrue(
        required.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
    })
  })
})
