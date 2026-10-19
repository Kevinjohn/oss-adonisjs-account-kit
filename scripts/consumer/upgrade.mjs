// Upgrade: install the baseline archive, then the candidate, and check app-owned files survive.
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  adaptGeneratedUserSchema,
  configure,
  databaseEnvironment,
  installArchive,
  packageMigrations,
} from './consumer_app.mjs'
import { digest, hashFiles, run } from './harness.mjs'
import { resetExclusivePostgresSchema } from './postgres.mjs'
import { fixtureRoot, tempRoot } from './settings.mjs'

export async function runUpgrade(candidate, baseline, runName) {
  const appRoot = join(tempRoot, runName)
  await cp(fixtureRoot, appRoot, {
    recursive: true,
    filter: (path) => !path.includes('/node_modules/'),
  })
  await mkdir(join(appRoot, 'tmp'), { recursive: true })
  const env = databaseEnvironment(appRoot)
  const configPath = join(appRoot, 'config/account_kit.ts')
  const handlerPath = join(appRoot, 'app/exceptions/handler.ts')
  const controllerPath = join(appRoot, 'app/controllers/password_resets_controller.ts')
  await copyFile(join(appRoot, 'upgrade/baseline_account_kit.stub'), configPath)
  await copyFile(join(appRoot, 'upgrade/baseline_handler.ts'), handlerPath)
  // Only the temporary historical fixture uses the baseline package vocabulary.
  const controller = await readFile(controllerPath, 'utf8')
  await writeFile(
    controllerPath,
    controller
      .replaceAll('.passwordReset.', '.recovery.')
      .replaceAll('.emailVerification.', '.verification.')
      .replaceAll('.emailPasswordManagement.', '.credentials.')
  )
  for (const migration of await packageMigrations(appRoot)) await rm(migration)
  const baselineInstall = await installArchive(appRoot, baseline)
  await resetExclusivePostgresSchema(appRoot)
  await configure(appRoot, env)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'migrate'], appRoot, env)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'format'], appRoot, env)
  run('pnpm', ['run', 'test:upgrade-baseline'], appRoot, {
    ...env,
    ACCOUNT_KIT_UPGRADE_PHASE: 'baseline',
  })

  const configBeforeUpgrade = await digest(configPath)
  const migrationDir = join(appRoot, 'database/migrations')
  const appMigrations = (await readdir(migrationDir)).sort()
  const appMigrationHashes = await hashFiles(appMigrations.map((file) => join(migrationDir, file)))
  const candidateInstall = await installArchive(appRoot, candidate)
  await configure(appRoot, env)
  if ((await digest(configPath)) !== configBeforeUpgrade)
    throw new Error('Upgrade replaced the app-owned config')
  const upgradedMigrations = (await readdir(migrationDir)).sort()
  if (appMigrations.some((file) => !upgradedMigrations.includes(file)))
    throw new Error('Upgrade configure removed an existing application migration')
  if (
    JSON.stringify(await hashFiles(appMigrations.map((file) => join(migrationDir, file)))) !==
    JSON.stringify(appMigrationHashes)
  )
    throw new Error('Upgrade configure changed an existing application migration')
  const newlyGenerated = upgradedMigrations.filter((file) => !appMigrations.includes(file))
  const resetMigration = newlyGenerated.find((file) =>
    file.endsWith('_account_kit_create_password_reset_tokens.ts')
  )
  const expectedSuffixes = [
    '_account_kit_create_password_reset_tokens.ts',
    '_account_kit_create_account_transaction_lock.ts',
    '_account_kit_evolve_identity_contract.ts',
    '_account_kit_create_social_identities.ts',
    '_account_kit_retire_account_email_changes.ts',
    '_account_kit_add_credentials_changed_at_to_users.ts',
    '_account_kit_create_social_transactions.ts',
    '_account_kit_add_social_identity_confirmation.ts',
  ]
  if (
    newlyGenerated.length !== expectedSuffixes.length ||
    !resetMigration ||
    expectedSuffixes.some((suffix, index) => !newlyGenerated[index]?.endsWith(suffix))
  ) {
    throw new Error(
      `Upgrade should add only the eight expected account migrations in order; added: ${newlyGenerated.join(', ')}`
    )
  }
  // Rehearse the documented application-owned table rename without editing applied migrations.
  await writeFile(
    join(migrationDir, resetMigration),
    `import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.renameTable('account_recovery_tokens', 'password_reset_tokens')
  }

  async down() {
    this.schema.renameTable('password_reset_tokens', 'account_recovery_tokens')
  }
}
`
  )
  await copyFile(join(fixtureRoot, 'config/account_kit.ts'), configPath)
  await copyFile(join(fixtureRoot, 'app/exceptions/handler.ts'), handlerPath)
  await writeFile(controllerPath, controller)
  const manuallyUpdatedConfigSha256 = await digest(configPath)
  const manuallyUpdatedHandlerSha256 = await digest(handlerPath)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  run('pnpm', ['run', 'migrate'], appRoot, env)
  run('pnpm', ['run', 'format'], appRoot, env)
  run('pnpm', ['run', 'typecheck'], appRoot, env)
  run('pnpm', ['run', 'lint'], appRoot, env)
  run('pnpm', ['run', 'format:check'], appRoot, env)
  run('pnpm', ['run', 'test:upgrade-baseline'], appRoot, {
    ...env,
    ACCOUNT_KIT_UPGRADE_PHASE: 'candidate',
  })
  run('pnpm', ['run', 'test'], appRoot, env)
  run('pnpm', ['run', 'test:session'], appRoot, {
    ...env,
    ACCOUNT_KIT_AUTH_STRATEGY: 'session',
    SESSION_DRIVER: 'memory',
  })
  return {
    appRoot,
    baselineInstall,
    candidateInstall,
    preservedBaselineConfigSha256: configBeforeUpgrade,
    manuallyUpdatedConfigSha256,
    manuallyUpdatedHandlerSha256,
  }
}
