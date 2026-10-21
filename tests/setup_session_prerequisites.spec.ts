import { rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { planSetup } from '../src/setup/plan.js'
import { withFixture } from './helpers/setup_prerequisites.js'

test.group('setup session prerequisites', () => {
  test('rejects an aliased cookie session and leaves dynamic custom stores unverified', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "export default { store: 'browser', stores: { browser: stores.cookie() } }"
      const cookie = await planSetup(choices, state)
      assert.isTrue(
        cookie.diagnostics.some(
          ({ field, message, severity }) =>
            field === 'config/session.ts' && severity === 'error' && message.includes('Cookie-only')
        )
      )
      state.files['config/session.ts'] =
        'export default { store: "browser", stores: { "browser": stores.cookie() } }'
      const quotedAlias = await planSetup(choices, state)
      assert.isTrue(
        quotedAlias.diagnostics.some(
          ({ field, message, severity }) =>
            field === 'config/session.ts' && severity === 'error' && message.includes('Cookie-only')
        )
      )
      state.files['config/session.ts'] =
        "export default { store: 'custom', stores: { custom: makeCustomStore() } }"
      const custom = await planSetup(choices, state)
      assert.isTrue(
        custom.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
    })
  })

  test('production memory sessions conflict with persistence claims', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "export default { store: 'memory', stores: { memory: stores.memory() } }"
      choices.authentication!.session!.persistentStore = true
      const plan = await planSetup(choices, state, { production: true })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'config/session.ts' &&
            severity === 'error' &&
            message.includes('persistent shared')
        )
      )
    })
  })

  test('managed session wrapper is replayable, reversible, and protects owner edits', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      const original =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER'), stores: { database: stores.database() } })\nexport default sessionConfig\n"
      const oldDriver = process.env.SESSION_DRIVER
      process.env.SESSION_DRIVER = 'database'
      try {
        state.files['config/session.ts'] = original
        const initial = await planSetup(choices, state)
        const session = initial.changes.find(({ path }) => path === 'config/session.ts')!
        assert.equal(session.action, 'update')
        assert.include(session.content, 'protectManagedSessionConfig')
        assert.include(session.content, 'accountKitSelectedSessionStore === "database"')
        state.files['config/session.ts'] = session.content
        state.existingChoices = structuredClone(choices)
        const repeated = await planSetup(choices, state)
        assert.equal(
          repeated.changes.find(({ path }) => path === 'config/session.ts')?.action,
          'unchanged'
        )
        const selected = await planSetup(choices, state)
        assert.isFalse(selected.diagnostics.some(({ field }) => field === 'config/session.ts'))
        const disabled = structuredClone(choices)
        disabled.managed = []
        const retirement = await planSetup(disabled, state)
        const unwrapped = retirement.changes.find(({ path }) => path === 'config/session.ts')!
        assert.equal(unwrapped.action, 'update')
        assert.equal(unwrapped.content, original)
        state.files['config/session.ts'] = unwrapped.content
        state.existingChoices = disabled
        const reenabled = await planSetup(choices, state)
        assert.equal(
          reenabled.changes.find(({ path }) => path === 'config/session.ts')?.content,
          session.content
        )
        state.files['config/session.ts'] = session.content.replace("'destroy'", "'destroyOther'")
        const ownerEdit = await planSetup(choices, state)
        assert.isTrue(ownerEdit.diagnostics.some(({ field }) => field === 'config/session.ts'))
      } finally {
        if (oldDriver === undefined) delete process.env.SESSION_DRIVER
        else process.env.SESSION_DRIVER = oldDriver
      }
    })
  })

  test('unsupported session config requires manual protection before apply', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        'export default defineConfig({ store: pickSessionStore(), stores: { custom: makeStore() } })'
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'config/session.ts' &&
            severity === 'error' &&
            message.includes('protectManagedSessionConfig')
        )
      )
      state.files['config/session.ts'] =
        "const sessionConfig = defineConfig({ store: 'custom', unrelated: { custom: stores.database() }, stores: { custom: makeStore() } })\nexport default sessionConfig\n"
      const unrelated = await planSetup(choices, state)
      assert.isTrue(
        unrelated.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'config/session.ts' &&
            severity === 'error' &&
            message.includes('protectManagedSessionConfig')
        )
      )
    })
  })

  test('session attestation requires the native binding and direct stores map', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      const config = (binding: string, body: string) =>
        `${binding}\nconst sessionConfig = defineConfig({ store: 'database', ${body} })\nexport default sessionConfig\n`
      const customBinding = config(
        "import { defineConfig, stores } from './custom_session.js'",
        'stores: { database: stores.database() }'
      )
      const nestedOnly = config(
        "import { defineConfig, stores } from '@adonisjs/session'",
        'unrelated: { stores: { database: stores.database() } }'
      )
      const typeOnly = config(
        "import type { defineConfig, stores } from '@adonisjs/session'",
        'stores: { database: stores.database() }'
      )
      for (const source of [customBinding, nestedOnly, typeOnly]) {
        state.files['config/session.ts'] = source
        const plan = await planSetup(choices, state)
        assert.isTrue(
          plan.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isUndefined(plan.changes.find(({ path }) => path === 'config/session.ts'))
      }
    })
  })

  test('an unused native sibling cannot attest a selected custom store', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'custom', stores: { database: stores.database(), custom: customStore() } })\nexport default sessionConfig\n"
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'config/session.ts' &&
            severity === 'error' &&
            message.includes('selected session factory')
        )
      )
      assert.isUndefined(plan.changes.find(({ path }) => path === 'config/session.ts'))
      const prior = process.env.SESSION_DRIVER
      process.env.SESSION_DRIVER = 'custom'
      try {
        state.files['config/session.ts'] = state.files['config/session.ts'].replace(
          "store: 'custom'",
          "store: env.get('SESSION_DRIVER')"
        )
        const selectedFromEnvironment = await planSetup(choices, state)
        assert.isTrue(
          selectedFromEnvironment.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
      } finally {
        if (prior === undefined) delete process.env.SESSION_DRIVER
        else process.env.SESSION_DRIVER = prior
      }
    })
  })

  test('a later store override cannot borrow an earlier native attestation', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      for (const stores of [
        'database: stores.database(), database: customStore()',
        String.raw`database: stores.database(), '\u0064atabase': customStore()`,
        'database: stores.database(), ...customStores',
      ]) {
        state.files['config/session.ts'] =
          `import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'database', stores: { ${stores} } })\nexport default sessionConfig\n`
        const plan = await planSetup(choices, state)
        assert.isTrue(
          plan.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isUndefined(plan.changes.find(({ path }) => path === 'config/session.ts'))
      }
    })
  })

  test('selected session environment follows Adonis precedence without exposing other values', async ({
    assert,
  }) => {
    await withFixture(async (choices, state, root) => {
      const prior = {
        selected: process.env.SESSION_DRIVER,
        mode: process.env.NODE_ENV,
        path: process.env.ENV_PATH,
      }
      try {
        delete process.env.SESSION_DRIVER
        delete process.env.ENV_PATH
        process.env.NODE_ENV = 'development'
        state.files['config/session.ts'] =
          "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER'), stores: { database: stores.database(), memory: stores.memory() } })\nexport default sessionConfig\n"
        await writeFile(join(root, '.env'), 'SESSION_DRIVER=memory\nPRIVATE_VALUE=hidden-value\n')
        await writeFile(join(root, '.env.development'), 'SESSION_DRIVER=database\n')
        const fromFile = await planSetup(choices, state)
        assert.isFalse(
          fromFile.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isFalse(JSON.stringify(fromFile).includes('hidden-value'))
        await writeFile(join(root, '.env.development.local'), 'SESSION_DRIVER="memory"\n')
        const local = await planSetup(choices, state)
        assert.isFalse(
          local.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        process.env.SESSION_DRIVER = 'database'
        const override = await planSetup(choices, state)
        assert.isFalse(
          override.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        process.env.SESSION_DRIVER = 'custom'
        const rejected = await planSetup(choices, state)
        assert.isTrue(
          rejected.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
      } finally {
        for (const [name, value] of [
          ['SESSION_DRIVER', prior.selected],
          ['NODE_ENV', prior.mode],
          ['ENV_PATH', prior.path],
        ] as const) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }
    })
  })

  test('session selector rejects ambiguous, unresolved, and linked environment files', async ({
    assert,
  }) => {
    await withFixture(async (choices, state, root) => {
      const prior = process.env.SESSION_DRIVER
      try {
        delete process.env.SESSION_DRIVER
        state.files['config/session.ts'] =
          "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER'), stores: { database: stores.database() } })\nexport default sessionConfig\n"
        const missing = await planSetup(choices, state)
        assert.isTrue(
          missing.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        for (const assignment of [
          'SESSION_DRIVER=$OTHER\n',
          'SESSION_DRIVER=database\nSESSION_DRIVER=custom\n',
          'SESSION_DRIVER="database\n',
          'PRIVATE_TEXT="first line\nSESSION_DRIVER=database\nlast line"\n',
        ]) {
          await writeFile(join(root, '.env'), assignment)
          const rejected = await planSetup(choices, state)
          assert.isTrue(
            rejected.diagnostics.some(
              ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
            )
          )
          assert.isUndefined(rejected.changes.find(({ path }) => path === 'config/session.ts'))
        }
        await rm(join(root, '.env'))
        await symlink('/tmp/unsupported-session-env', join(root, '.env'))
        const linked = await planSetup(choices, state)
        assert.isTrue(
          linked.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isFalse(JSON.stringify(linked).includes('/tmp/unsupported-session-env'))
      } finally {
        if (prior === undefined) delete process.env.SESSION_DRIVER
        else process.env.SESSION_DRIVER = prior
      }
    })
  })

  test('session selector reads only the variable named by the configured expression', async ({
    assert,
  }) => {
    await withFixture(async (choices, state, root) => {
      const prior = process.env.SESSION_DRIVER
      try {
        process.env.SESSION_DRIVER = 'database'
        state.files['config/session.ts'] =
          "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('APP_SESSION_STORE'), stores: { database: stores.database() } })\nexport default sessionConfig\n"
        const missing = await planSetup(choices, state)
        assert.isTrue(
          missing.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        await writeFile(join(root, '.env'), 'APP_SESSION_STORE=database\n')
        const selected = await planSetup(choices, state)
        assert.isFalse(
          selected.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
      } finally {
        if (prior === undefined) delete process.env.SESSION_DRIVER
        else process.env.SESSION_DRIVER = prior
      }
    })
  })

  test('native session attestation requires complete selected factory expressions', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      for (const config of [
        "{ store: 'database' + suffix, stores: { database: stores.database() } }",
        "{ store: 'database', stores: { database: stores.database() && customFactory } }",
        "{ store: 'database', stores: { database: stores.database() }, ...override }",
      ]) {
        state.files['config/session.ts'] =
          `import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig(${config})\nexport default sessionConfig\n`
        const plan = await planSetup(choices, state)
        assert.isTrue(
          plan.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isUndefined(plan.changes.find(({ path }) => path === 'config/session.ts'))
      }
      state.files['config/session.ts'] =
        "import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'database', stores: { database: stores.database() } })\nObject.assign(sessionConfig, { store: 'custom' })\nexport default sessionConfig\n"
      const mutated = await planSetup(choices, state)
      assert.isTrue(
        mutated.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
    })
  })

  test('quoted wrapper examples cannot bypass actual managed session wiring', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "import { defineConfig, stores } from '@adonisjs/session'\nconst example = `protectManagedSessionConfig(sessionConfig, {})`\nconst sessionConfig = defineConfig({ store: 'database', stores: { database: stores.database() } })\nexport default sessionConfig\n"
      const plan = await planSetup(choices, state)
      const session = plan.changes.find(({ path }) => path === 'config/session.ts')
      assert.equal(session?.action, 'update')
      assert.include(session?.content ?? '', 'export default protectManagedSessionConfig(')
      assert.isFalse(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
    })
  })

  test('dotenv-selected memory store is rejected in production', async ({ assert }) => {
    await withFixture(async (choices, state, root) => {
      const prior = process.env.APP_SESSION_STORE
      try {
        delete process.env.APP_SESSION_STORE
        await writeFile(join(root, '.env'), 'APP_SESSION_STORE=memory\n')
        state.files['config/session.ts'] =
          "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('APP_SESSION_STORE'), stores: { database: stores.database(), memory: stores.memory() } })\nexport default sessionConfig\n"
        const plan = await planSetup(choices, state, { production: true })
        assert.isTrue(
          plan.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/session.ts' &&
              severity === 'error' &&
              message.includes('persistent shared')
          )
        )
      } finally {
        if (prior === undefined) delete process.env.APP_SESSION_STORE
        else process.env.APP_SESSION_STORE = prior
      }
    })
  })

  test('multiline selected session wrapper survives replay and removal', async ({ assert }) => {
    await withFixture(async (choices, state, root) => {
      state.files['config/session.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get(\n  'SESSION_DRIVER',\n  'database'\n), stores: { database: stores.database() } })\nexport default sessionConfig\n"
      const first = await planSetup(choices, state)
      const wrapped = first.changes.find(({ path }) => path === 'config/session.ts')!.content
      state.files['config/session.ts'] = wrapped
      const replay = await planSetup(choices, state)
      assert.isFalse(
        replay.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
      choices.managed = []
      const removed = await planSetup(choices, state)
      assert.isFalse(
        removed.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
      assert.include(
        removed.changes.find(({ path }) => path === 'config/session.ts')!.content,
        "env.get(\n  'SESSION_DRIVER'"
      )
      void root
    })
  })
})
