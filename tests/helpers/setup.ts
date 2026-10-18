import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Group } from '@japa/runner/core'
import { defaultSetupChoices } from '../../src/setup/defaults.js'

export { retirementIgnitor } from './retirement_ignitor.js'

export const cleanupRoots: string[] = []

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'account-setup-'))
  cleanupRoots.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'start'), { recursive: true })
  await mkdir(join(root, 'app/models'), { recursive: true })
  await mkdir(join(root, 'app/services'), { recursive: true })
  await writeFile(
    join(root, 'app/models/user.ts'),
    "import { BaseModel, column } from '@adonisjs/lucid/orm'\nimport { DbAccessTokensProvider } from '@adonisjs/auth/access_tokens'\nexport default class User extends BaseModel { @column({ isPrimary: true }) declare id: number; static accessTokens = DbAccessTokensProvider.forModel(User); email!: string; password!: string; emailVerifiedAt!: Date }\n"
  )
  await writeFile(
    join(root, 'app/services/account_kit_policy.ts'),
    'export const accountKitPolicy = { canAccess: async () => true }\n'
  )
  await writeFile(
    join(root, 'app/services/account_kit_notifications.ts'),
    'export const accountKitNotifications = {}\n'
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      dependencies: {
        'typescript': '^5.9.3',
        '@adonisjs/core': '7',
        '@adonisjs/lucid': '22',
        '@adonisjs/limiter': '3',
        '@adonisjs/auth': '10',
        '@adonisjs/session': '8',
        '@adonisjs/shield': '9',
        '@vinejs/vine': '4',
        'adonisjs-account-kit': '0',
      },
      imports: { '#models/*': './app/models/*.js', '#database/*': './database/*.js' },
    })
  )
  for (const [name, version] of Object.entries({
    'typescript': '5.9.3',
    '@adonisjs/core': '7.0.0',
    '@adonisjs/lucid': '22.4.2',
    '@adonisjs/limiter': '3.0.0',
    '@adonisjs/auth': '10.1.0',
    '@adonisjs/session': '8.1.0',
    '@adonisjs/shield': '9.0.0',
    '@vinejs/vine': '4.4.0',
    'adonisjs-account-kit': '0.0.0',
  })) {
    await mkdir(join(root, 'node_modules', name), { recursive: true })
    await writeFile(
      join(root, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version })
    )
  }
  await writeFile(
    join(root, 'config/auth.ts'),
    "import { defineConfig } from '@adonisjs/auth'\nimport { sessionGuard, sessionUserProvider } from '@adonisjs/auth/session'\nimport { tokensGuard, tokensUserProvider } from '@adonisjs/auth/access_tokens'\nexport default defineConfig({ guards: { web: sessionGuard({ provider: sessionUserProvider({ model: () => import('#models/user') }) }), api: tokensGuard({ provider: tokensUserProvider({ tokens: 'accessTokens', model: () => import('#models/user') }) })\n} })\n"
  )
  await writeFile(
    join(root, 'config/database.ts'),
    "import { defineConfig } from '@adonisjs/lucid'\nexport default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3' } } })\n"
  )
  await writeFile(
    join(root, 'config/limiter.ts'),
    'import { defineConfig, stores } from \'@adonisjs/limiter\'\nexport default defineConfig({ default: "database", stores: { database: stores.database({ tableName: "rate_limits" }) } })\n'
  )
  await writeFile(join(root, 'config/shield.ts'), 'export default { csrf: { enabled: true } }\n')
  await writeFile(
    join(root, 'config/session.ts'),
    "import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'database', stores: { database: stores.database() } })\nexport default sessionConfig\n"
  )
  await writeFile(join(root, 'adonisrc.ts'), 'export default { providers: [] }\n')
  await writeFile(join(root, 'start/routes.ts'), '// application routes\n')
  await writeFile(
    join(root, 'start/kernel.ts'),
    "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([\n  () => import('@adonisjs/cors/cors_middleware'),\n])\nrouter.use([\n  () => import('@adonisjs/core/bodyparser_middleware'),\n])\n"
  )
  const choices = defaultSetupChoices()
  choices.features = ['passwordReset']
  choices.managed = ['passwordReset']
  choices.authentication!.applicationRouteRevocation = true
  choices.policy.accessRestrictionHook = true
  choices.policy.registration = 'closed'
  choices.policy.verificationRequired = false
  choices.mail.integration = 'custom'
  choices.mail.senderEnv = null
  choices.mail.transportEnv = null
  choices.mail.destinations = { passwordReset: 'account/recovery' }
  choices.social = { status: 'not-applicable', reason: 'Social sign-in not selected' }
  return { root, choices }
}

export function registerSetupTeardown(group: Group) {
  group.teardown(async () => {
    for (const root of cleanupRoots) await rm(root, { recursive: true, force: true })
  })
}
