import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSetupChoices } from '../../src/setup/defaults.js'
import type { SetupChoices, SetupInspection } from '../../src/setup/types.js'
import { setupVersions } from './setup_versions.js'

export const versions: Record<string, string> = { ...setupVersions, '@adonisjs/mail': '10.0.0' }

export async function prerequisiteFixture() {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-prerequisites-'))
  await mkdir(join(root, 'app/models'), { recursive: true })
  await writeFile(
    join(root, 'app/models/user.ts'),
    "import { BaseModel, column } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { @column({ isPrimary: true }) declare id: number }"
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ imports: { '#models/*': './app/models/*.js' } })
  )
  const choices = defaultSetupChoices()
  choices.policy.accessRestrictionHook = true
  choices.mail.integration = 'custom'
  choices.mail.senderEnv = null
  choices.mail.transportEnv = null
  const state: SetupInspection = {
    root,
    existingInstallation: false,
    files: {
      'adonisrc.ts': 'export default { providers: [] }',
      'start/routes.ts': '// application routes',
      'start/kernel.ts':
        "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([() => import('@adonisjs/cors/cors_middleware')])\nrouter.use([() => import('@adonisjs/core/bodyparser_middleware')])",
      'config/shield.ts': 'export default { csrf: { enabled: true } }',
      'config/session.ts':
        "export default { store: 'database', stores: { database: stores.database() } }",
      'config/limiter.ts':
        "import { defineConfig, stores } from '@adonisjs/limiter'\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })",
      'app/services/account_kit_policy.ts': 'export const accountKitPolicy = {}',
      'app/services/account_kit_notifications.ts': 'export const accountKitNotifications = {}',
    },
    guards: ['web'],
    guardStrategies: { web: 'session' },
    guardModels: { web: '#models/user' },
    guardTokenProviders: {},
    installedVersions: { ...versions },
    installedPackages: Object.keys(versions),
    database: 'sqlite',
    connection: 'default',
    migrationNames: ['create_sessions.ts'],
    existingPrefix: null,
    routePaths: [],
    routeDefinitions: [],
    existingChoices: null,
  }
  return { root, choices, state }
}

export async function withFixture(
  run: (choices: SetupChoices, state: SetupInspection, root: string) => Promise<void>
) {
  const { root, choices, state } = await prerequisiteFixture()
  try {
    await run(choices, state, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
