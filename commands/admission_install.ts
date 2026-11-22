import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import { migrationSchema, type UserIdType } from '../src/setup/migration_definitions.js'
import { inspectMigrationDirectory } from '../src/setup/migration_paths.js'
import { orderedMigrations } from '../src/setup/migration_order.js'
import { readRegularFile } from '../src/setup/safe_path.js'
import { hasRegisteredCommand } from '../src/setup/commands_inspection.js'
import { stubsRoot } from '../stubs/main.js'

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
    description: 'Application-relative directory used by Lucid when the path is dynamic',
  })
  declare migrationDirectory?: string

  async run(): Promise<void> {
    let schema: ReturnType<typeof migrationSchema>
    let migrationPath: string
    let existing: boolean
    try {
      schema = migrationSchema(
        this.usersTable ?? 'users',
        (this.userIdType ?? 'integer') as UserIdType
      )
      const root = resolve(this.app.makePath(''))
      const directory = await inspectMigrationDirectory(
        root,
        (await readRegularFile(root, relative(root, this.app.configPath('database.ts')))) ?? '',
        this.migrationDirectory,
        process.env,
        relative(root, this.app.migrationsPath()).split(sep).join('/')
      )
      const [migration] = orderedMigrations(directory.names, Date.now(), [
        'admission_create_account_admissions',
      ])
      migrationPath = `${directory.path}/${migration.filename}`
      existing = migration.existing
    } catch (error) {
      this.exitCode = 1
      this.logger.logError((error as Error).message)
      return
    }
    const codemods = await this.createCodemods()
    codemods.overwriteExisting = false
    await codemods.makeUsingStub(stubsRoot, 'config/admission.stub', {})

    if (existing) this.logger.info(`Skipped ${migrationPath}`)
    else
      await codemods.makeUsingStub(stubsRoot, 'migrations/create_account_admissions.stub', {
        migration: { ...schema, destination: this.app.makePath(migrationPath) },
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
      '  2. Gate protected routes with admissionMiddleware(...), and keep the admission status route reachable'
    )
    this.logger.log(
      '  3. Decide who may approve in config/admission.ts (approval.authorize), then run node ace migration:run'
    )
  }
}
