import { environmentOverrides } from './environment_overrides.ts'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import { buildMigrationSchema, type UserIdType } from '../src/setup/migration_definitions.ts'
import { inspectMigrationDirectory, migrationStubPath } from '../src/setup/migration_paths.ts'
import { orderMigrations } from '../src/setup/migration_order.ts'
import { readRegularFile } from '../src/setup/safe_path.ts'
import { hasRegisteredCommand } from '../src/setup/commands_inspection.ts'
import { stubsRoot } from '../stubs/main.ts'

const admissionMigration = 'admission_create_account_admissions'

/**
 * Adds the optional admission module: the `account_admissions` migration and `config/admission.ts`
 * from stubs, and the provider and command loader in `adonisrc.ts`. Never overwrites a file.
 */
export default class InstallAdmission extends BaseCommand {
  static commandName = 'account-kit:admission:install'
  static description =
    'Add the admission module: migration, config/admission.ts, provider and commands'

  @flags.string({ description: 'Users table the migration references (default users)' })
  declare usersTable?: string

  @flags.string({ description: 'User id column type: integer, string or uuid (default integer)' })
  declare userIdType?: string

  @flags.string({
    description:
      'Application-relative Lucid migration directory: a dynamic path or one of several paths',
  })
  declare migrationDirectory?: string

  @flags.array({ description: 'Explicit setup environment override (NAME=value, repeatable)' })
  declare env?: string[]

  async run(): Promise<void> {
    const root = resolve(this.app.makePath(''))
    let schema: ReturnType<typeof buildMigrationSchema>
    let migrationPath: string
    let existing: boolean
    try {
      schema = buildMigrationSchema(
        this.usersTable ?? 'users',
        (this.userIdType ?? 'integer') as UserIdType
      )
      const directory = await inspectMigrationDirectory(
        root,
        (await readRegularFile(root, relative(root, this.app.configPath('database.ts')))) ?? '',
        this.migrationDirectory,
        environmentOverrides(this.env),
        relative(root, this.app.migrationsPath()).split(sep).join('/'),
        [admissionMigration]
      )
      const [migration] = orderMigrations(directory.names, Date.now(), [admissionMigration])
      migrationPath = `${directory.path}/${migration.filename}`
      existing = migration.existing
    } catch (error) {
      this.exitCode = 1
      this.logger.logError(
        `${(error as Error).message}. Nothing was written: config/admission.ts, the migration, the provider and the commands are unchanged.`
      )
      return
    }
    const codemods = await this.createCodemods()
    codemods.overwriteExisting = false
    await codemods.makeUsingStub(stubsRoot, 'config/admission.stub', {})

    if (existing) this.logger.info(`Skipped ${migrationPath}`)
    else
      await codemods.makeUsingStub(stubsRoot, 'migrations/create_account_admissions.stub', {
        migration: {
          ...schema,
          path: migrationStubPath(this.app.migrationsPath(), resolve(root, migrationPath)),
        },
      })

    const rcContents = await readFile(this.app.makePath('adonisrc.ts'), 'utf8')
    const commandAlreadyRegistered = await hasRegisteredCommand(
      rcContents,
      '@kevinjohn/adonisjs-account-kit/admission/commands'
    )
    await codemods.updateRcFile((rcFile) => {
      rcFile.addProvider('@kevinjohn/adonisjs-account-kit/admission/provider')
      if (!commandAlreadyRegistered)
        rcFile.addCommand('@kevinjohn/adonisjs-account-kit/admission/commands')
    })

    this.logger.info('Finish admission in your application:')
    this.logger.log(
      '  1. In config/account_kit.ts, wrap onInvitationAccepted with withInvitationEvidence(...) and set onAccountDeletingTransaction: withAdmissionCleanup(...)'
    )
    this.logger.log(
      '  2. Gate protected routes with AdmissionMiddleware, and keep the admission status route reachable'
    )
    this.logger.log(
      '  3. Decide who may approve in config/admission.ts (approval.authorize), then run node ace migration:run'
    )
  }
}
