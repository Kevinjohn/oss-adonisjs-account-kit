import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { planSetup } from '../src/setup/plan.js'

async function applicationRoot() {
  const root = await mkdtemp(join(tmpdir(), 'account-setup-inspect-'))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'package.json'), '{}')
  return root
}

test('commented guards and models do not become setup prerequisites', async ({ assert }) => {
  const root = await applicationRoot()
  try {
    const authPath = join(root, 'config/auth.ts')
    await writeFile(
      authPath,
      [
        '/* web: sessionGuard({ provider: sessionUserProvider({ model: () => import("#models/ghost") }) }) */',
        '// api: tokensGuard({ provider: tokensUserProvider({ model: () => import("#models/ghost") }) })',
        'export default { guards: {} }',
      ].join('\n')
    )
    const commented = await inspectSetup(root)
    assert.deepEqual(commented.guards, [])
    assert.deepEqual(commented.guardModels, {})

    await writeFile(
      authPath,
      [
        "import { defineConfig } from '@adonisjs/auth'",
        "import { sessionGuard, sessionUserProvider } from '@adonisjs/auth/session'",
        "import { tokensGuard, tokensUserProvider } from '@adonisjs/auth/access_tokens'",
        'export default defineConfig({ guards: {',
        '  web: sessionGuard({ provider: sessionUserProvider({ model: () => import("#models/user") }) }),',
        '  api: tokensGuard({ provider: tokensUserProvider({ model: () => import("#models/user") }) }),',
        '} })',
      ].join('\n')
    )
    const live = await inspectSetup(root)
    assert.deepEqual(live.guardStrategies, { web: 'session', api: 'access_tokens' })
    assert.deepEqual(live.guardModels, { web: '#models/user', api: '#models/user' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('changed and ambiguous exported config cannot certify guards or database', async ({
  assert,
}) => {
  const root = await applicationRoot()
  try {
    const auth = join(root, 'config/auth.ts')
    await writeFile(
      auth,
      "import { defineConfig } from '@adonisjs/auth'\nimport { sessionGuard } from '@adonisjs/auth/session'\nconst config = defineConfig({ guards: { web: sessionGuard({}) } })\nconfig.guards = {}\nexport default config"
    )
    const mutatedAuth = await inspectSetup(root)
    assert.deepEqual(mutatedAuth.guardStrategies, {})
    await writeFile(
      auth,
      "import { defineConfig } from '@adonisjs/auth'\nimport { sessionGuard } from '@adonisjs/auth/session'\nexport default defineConfig({ guards: { web: sessionGuard({}), ['web']: null } })"
    )
    const ambiguousAuth = await inspectSetup(root)
    assert.deepEqual(ambiguousAuth.guardStrategies, {})
    const database = join(root, 'config/database.ts')
    await writeFile(
      database,
      "import { defineConfig } from '@adonisjs/lucid'\nconst config = defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3' } } })\nconfig.connection = 'mysql'\nexport default config"
    )
    const mutatedDatabase = await inspectSetup(root)
    assert.equal(mutatedDatabase.database, 'unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mutated environment getter cannot certify database fallback', async ({ assert }) => {
  const root = await applicationRoot()
  try {
    await writeFile(
      join(root, 'config/database.ts'),
      "import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nenv.get = () => 'mysql'\nexport default defineConfig({ connection: env.get('DB_CONNECTION', 'sqlite'), connections: { sqlite: { client: 'better-sqlite3' }, mysql: { client: 'mysql2' } } })"
    )
    const state = await inspectSetup(root)
    assert.equal(state.database, 'unknown')
    const plan = await planSetup(defaultSetupChoices(), state)
    assert.isTrue(
      plan.diagnostics.some(
        ({ field, severity }) => field === 'database.client' && severity === 'error'
      )
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('additional executable environment imports invalidate database selection', async ({
  assert,
}) => {
  const root = await applicationRoot()
  const previous = process.env.DB_CONNECTION
  try {
    delete process.env.DB_CONNECTION
    const database = join(root, 'config/database.ts')
    await writeFile(
      database,
      "import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nimport * as envModule from '#start/env'\nenvModule.default.get = () => 'mysql'\nexport default defineConfig({ connection: env.get('DB_CONNECTION', 'sqlite'), connections: { sqlite: { client: 'better-sqlite3' }, mysql: { client: 'mysql2' } } })"
    )
    const namespaceAlias = await inspectSetup(root)
    assert.equal(namespaceAlias.database, 'unknown')
    await writeFile(
      database,
      "import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nimport { default as alternative } from '#start/env'\nalternative.get = () => 'mysql'\nexport default defineConfig({ connection: env.get('DB_CONNECTION', 'sqlite'), connections: { sqlite: { client: 'better-sqlite3' }, mysql: { client: 'mysql2' } } })"
    )
    const namedAlias = await inspectSetup(root)
    assert.equal(namedAlias.database, 'unknown')
    await writeFile(
      database,
      "import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nimport type * as EnvTypes from '#start/env'\nexport default defineConfig({ connection: env.get('DB_CONNECTION', 'sqlite'), connections: { sqlite: { client: 'better-sqlite3' } } })"
    )
    const typeOnly = await inspectSetup(root)
    assert.equal(typeOnly.database, 'sqlite')
  } finally {
    if (previous === undefined) delete process.env.DB_CONNECTION
    else process.env.DB_CONNECTION = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('quoted and template examples cannot invent guards or models', async ({ assert }) => {
  const root = await applicationRoot()
  try {
    await writeFile(
      join(root, 'config/auth.ts'),
      [
        "import { defineConfig } from '@adonisjs/auth'",
        "import { sessionGuard, sessionUserProvider } from '@adonisjs/auth/session'",
        "import { tokensGuard, tokensUserProvider } from '@adonisjs/auth/access_tokens'",
        'const example = `guards: { ghost: tokensGuard({ provider: tokensUserProvider({ model: () => import("#models/ghost") }) }) }`',
        'const quoted = "api: tokensGuard({ provider: tokensUserProvider({ model: () => import(\\\"#models/ghost\\\") }) })"',
        'export default defineConfig({ guards: { "web": sessionGuard({ provider: sessionUserProvider({ model: () => import("#models/user") }) }) } })',
      ].join('\n')
    )
    const state = await inspectSetup(root)
    assert.deepEqual(state.guardStrategies, { web: 'session' })
    assert.deepEqual(state.guardModels, { web: '#models/user' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('route inventory reads actual router calls, not quoted examples', async ({ assert }) => {
  const root = await applicationRoot()
  try {
    await mkdir(join(root, 'start'))
    await writeFile(
      join(root, 'start/routes.ts'),
      [
        "import router from '@adonisjs/core/services/router'",
        'const quoted = "router.post(\\\"/account/auth/login\\\", handler)"',
        'const template = `router.get("/account/auth/signup", handler)`',
        "router.patch('/application/profile', handler)",
      ].join('\n')
    )
    const state = await inspectSetup(root)
    assert.deepEqual(state.routeDefinitions, [{ method: 'PATCH', path: '/application/profile' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('quoted database examples cannot override the executable connection', async ({ assert }) => {
  const root = await applicationRoot()
  try {
    await writeFile(
      join(root, 'config/database.ts'),
      [
        "import { defineConfig } from '@adonisjs/lucid'",
        'const example = `connection: "sqlite", connections: { sqlite: { client: "better-sqlite3" } }`',
        'const quoted = "client: \\\"better-sqlite3\\\""',
        'export default defineConfig({ connection: "mssql", connections: { mssql: { client: "mssql" }, sqlite: { client: "better-sqlite3" } } })',
      ].join('\n')
    )
    const unsupported = await inspectSetup(root)
    assert.equal(unsupported.database, 'unsupported')
    await writeFile(
      join(root, 'config/database.ts'),
      'import { defineConfig } from \'@adonisjs/lucid\'\nexport default defineConfig({ connection: "sqlite", connections: { "sqlite": { client: "better-sqlite3" } } })'
    )
    const sqlite = await inspectSetup(root)
    assert.equal(sqlite.database, 'sqlite')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard metadata must belong to the exported config and imported factories', async ({
  assert,
}) => {
  const root = await applicationRoot()
  try {
    await writeFile(
      join(root, 'config/auth.ts'),
      [
        "import { defineConfig as defineAuth } from '@adonisjs/auth'",
        "import { sessionGuard as session, sessionUserProvider as sessionProvider } from '@adonisjs/auth/session'",
        "import { tokensGuard, tokensUserProvider } from '@adonisjs/auth/access_tokens'",
        'const decoy = { guards: { ghost: tokensGuard({ provider: tokensUserProvider({ model: () => import("#models/ghost") }) }) } }',
        'const authConfig = defineAuth({ guards: { web: session({ provider: sessionProvider({ model: () => import("#models/user") }) }) } })',
        'export default authConfig',
      ].join('\n')
    )
    const state = await inspectSetup(root)
    assert.deepEqual(state.guardStrategies, { web: 'session' })
    assert.deepEqual(state.guardModels, { web: '#models/user' })
    await writeFile(
      join(root, 'config/auth.ts'),
      'const fake = () => null\nexport default fake({ guards: { web: sessionGuard({}) } })'
    )
    const unsupported = await inspectSetup(root)
    assert.deepEqual(unsupported.guardStrategies, {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('database selection uses process, dotenv, then literal default without guessing', async ({
  assert,
}) => {
  const root = await applicationRoot()
  const prior = process.env.DB_CONNECTION
  try {
    delete process.env.DB_CONNECTION
    const database = join(root, 'config/database.ts')
    await writeFile(
      database,
      [
        "import { defineConfig } from '@adonisjs/lucid'",
        "import env from '#start/env'",
        'export default defineConfig({ connection: env.get("DB_CONNECTION", "sqlite"), connections: { sqlite: { client: "better-sqlite3" }, pg: { client: "pg" }, mysql: { client: "mysql2" }, mssql: { client: "mssql" } } })',
      ].join('\n')
    )
    const fallback = await inspectSetup(root)
    assert.equal(fallback.database, 'sqlite')
    await writeFile(join(root, '.env'), 'DB_CONNECTION=pg\n')
    const dotenv = await inspectSetup(root)
    assert.equal(dotenv.database, 'postgres')
    await writeFile(join(root, '.env'), 'DB_CONNECTION=mysql\n')
    const mysql = await inspectSetup(root)
    assert.equal(mysql.database, 'mysql')
    for (const selected of ['mssql', 'unconfigured']) {
      await writeFile(join(root, '.env'), `DB_CONNECTION=${selected}\n`)
      const unsupported = await inspectSetup(root)
      assert.equal(unsupported.database, selected === 'mssql' ? 'unsupported' : 'unknown')
      const plan = await planSetup(defaultSetupChoices(), unsupported)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'database.client' && severity === 'error'
        )
      )
    }
    await writeFile(join(root, '.env'), 'DB_CONNECTION=pg\n')
    process.env.DB_CONNECTION = 'sqlite'
    const processSelected = await inspectSetup(root)
    assert.equal(processSelected.database, 'sqlite')
    delete process.env.DB_CONNECTION
    await rm(join(root, '.env'))
    await writeFile(
      database,
      "import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nexport default defineConfig({ connection: env.get('DB_CONNECTION'), connections: { sqlite: { client: 'better-sqlite3' } } })"
    )
    const unresolved = await inspectSetup(root)
    assert.equal(unresolved.database, 'unknown')
    await writeFile(join(root, '.env'), 'DB_CONNECTION=sqlite\n')
    await rm(join(root, '.env'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'account-env-outside-'))
    const outside = join(outsideRoot, '.env')
    try {
      await writeFile(outside, 'DB_CONNECTION=sqlite\n')
      await symlink(outside, join(root, '.env'))
      await assert.rejects(() => inspectSetup(root), /symlink|non-directory|regular file/)
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  } finally {
    if (prior === undefined) delete process.env.DB_CONNECTION
    else process.env.DB_CONNECTION = prior
    await rm(root, { recursive: true, force: true })
  }
})

test('resolved package metadata must be a regular in-application file', async ({ assert }) => {
  const root = await applicationRoot()
  const external = await mkdtemp(join(tmpdir(), 'account-setup-external-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { 'linked-package': '1.0.0' } })
    )
    await mkdir(join(root, 'vendor/linked-package'), { recursive: true })
    await mkdir(join(root, 'node_modules'))
    await symlink(join(root, 'vendor/linked-package'), join(root, 'node_modules/linked-package'))
    const metadata = join(root, 'vendor/linked-package/package.json')
    await writeFile(metadata, JSON.stringify({ version: '1.2.3' }))
    const installed = await inspectSetup(root)
    assert.equal(installed.installedVersions['linked-package'], '1.2.3')

    await writeFile(join(external, 'package.json'), JSON.stringify({ version: '99.0.0' }))
    await rm(metadata)
    await symlink(join(external, 'package.json'), metadata)
    await assert.rejects(() => inspectSetup(root), /non-regular file/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})
