import { readdir } from 'node:fs/promises'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import { migrationSchema, type UserIdType } from '../configure.js'
import { stubsRoot } from '../stubs/main.js'

export const admissionMigrationSuffix = '_account_kit_admission_create_account_admissions.ts'

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

  async run(): Promise<void> {
    let schema: ReturnType<typeof migrationSchema>
    try {
      schema = migrationSchema(
        this.usersTable ?? 'users',
        (this.userIdType ?? 'integer') as UserIdType
      )
    } catch (error) {
      this.exitCode = 1
      this.logger.logError((error as Error).message)
      return
    }
    const codemods = await this.createCodemods()
    codemods.overwriteExisting = false
    await codemods.makeUsingStub(stubsRoot, 'config/admission.stub', {})

    let migrations: string[] = []
    try {
      migrations = await readdir(this.app.makePath('database/migrations'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (migrations.some((name) => name.endsWith(admissionMigrationSuffix)))
      this.logger.info(`Skipped database/migrations/*${admissionMigrationSuffix}`)
    else
      await codemods.makeUsingStub(stubsRoot, 'migrations/create_account_admissions.stub', {
        migration: {
          ...schema,
          destination: this.app.makePath(
            `database/migrations/${Date.now()}${admissionMigrationSuffix}`
          ),
        },
      })

    await codemods.updateRcFile((rcFile) => {
      rcFile.addProvider('adonisjs-account-kit/admission/provider')
      rcFile.addCommand('adonisjs-account-kit/admission/commands')
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
