// Renders the API example's app-owned files for a users table and user ID type. The committed
// example is the integer `users` rendering; the consumer lays the other cells over its copy.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'
import type { UserIdType } from '../../../configure.js'

export const exampleRoot = fileURLToPath(new URL('../../../examples/api/', import.meta.url))

/** Example files, relative to `examples/api`, whose contents depend on the schema variant. */
export const apiVariantFiles = [
  'app/models/user.ts',
  'app/controllers/admissions_controller.ts',
  'database/migrations/1761885935168_create_users_table.ts',
  'database/migrations/1768620764696_create_access_tokens_table.ts',
  'database/migrations/1791906000000_create_role_assignments.ts',
  'database/migrations/1800000000001_create_notifications_outbox.ts',
  'database/migrations/1800000000003_make_user_full_name_nullable.ts',
] as const

export type ApiVariantFile = (typeof apiVariantFiles)[number]

/** A foreign-key column with the type of the users table's primary key. */
function idColumn(name: string, idType: UserIdType) {
  if (idType === 'integer') return `table.integer('${name}').unsigned()`
  if (idType === 'uuid') return `table.uuid('${name}')`
  return `table.string('${name}')`
}

function primaryKey(idType: UserIdType) {
  if (idType === 'integer') return `table.increments('id').notNullable()`
  if (idType === 'uuid') return `table.uuid('id').primary().notNullable()`
  return `table.string('id').primary().notNullable()`
}

function userModel(usersTable: string, idType: UserIdType) {
  const integer = idType === 'integer'
  const uuidImport = integer ? '' : "import { randomUUID } from 'node:crypto'\n"
  const hooks = integer ? 'beforeSave' : 'beforeCreate, beforeSave'
  const table = usersTable === 'users' ? '' : `  static table = '${usersTable}'\n`
  const selfAssign = integer
    ? ''
    : `  static selfAssignPrimaryKey = true

  @beforeCreate()
  static assignStringId(user: User) {
    if (!user.id) {
      Object.assign(user, { id: randomUUID() })
    }
  }
`
  return `${uuidImport}import { UserSchema } from '#database/schema'
import hash from '@adonisjs/core/services/hash'
import { compose } from '@adonisjs/core/helpers'
import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'
import { type AccessToken, DbAccessTokensProvider } from '@adonisjs/auth/access_tokens'
import { ${hooks} } from '@adonisjs/lucid/orm'

export default class User extends compose(UserSchema, withAuthFinder(hash)) {
${table}${selfAssign}  static accessTokens = DbAccessTokensProvider.forModel(User)
  declare currentAccessToken?: AccessToken

  @beforeSave()
  static normalizeEmail(user: User) {
    user.email = user.email.trim().toLowerCase()
  }

  get initials() {
    const [first, last] = this.fullName ? this.fullName.split(' ') : this.email.split('@')
    if (first && last) {
      return \`\${first.charAt(0)}\${last.charAt(0)}\`.toUpperCase()
    }
    return \`\${first.slice(0, 2)}\`.toUpperCase()
  }
}
`
}

function admissionsController(idType: UserIdType) {
  const integer = idType === 'integer'
  const userIdParam = integer
    ? `/** Integer ids must be positive integers, so a database never receives a malformed id. */
function userIdParam(value: string): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64)
    throw new InvalidInputError('Invalid user ID')
  const id = /^[1-9]\\d*$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(id)) throw new InvalidInputError('Invalid user ID')
  return id
}`
    : `/** Ids are opaque strings; a database never receives an empty or oversized id. */
function userIdParam(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64)
    throw new InvalidInputError('Invalid user ID')
  return value
}`
  return `import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { InvalidInputError } from '@kevinjohn/adonisjs-account-kit'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
import { accountInput } from '#services/account_input'
import { admissionListValidator } from '#validators/admission'

${userIdParam}

const admission = () => app.container.make(AccountAdmission)

/**
 * The account's own admission status and request, reachable while not admitted, and the owner's
 * list and decisions. The package sends no notification: this status is how a person learns the
 * decision.
 */
export default class AdmissionsController {
  async show(ctx: HttpContext) {
    const service = await admission()
    const { decision } = await service.current(accountInput(ctx))
    return ctx.response.ok(decision)
  }

  async request(ctx: HttpContext) {
    const service = await admission()
    const record = await service.request(accountInput(ctx))
    return ctx.response.ok({ requestedAt: record.requestedAt })
  }

  async index(ctx: HttpContext) {
    const actor = await ctx.auth.getUserOrFail()
    const { status, cursor, limit } = await ctx.request.validateUsing(admissionListValidator)
    const service = await admission()
    return ctx.response.ok(await service.list({ actorId: actor.id, status, cursor, limit }))
  }

  async approve(ctx: HttpContext) {
    return this.decide(ctx, 'approve')
  }

  async reject(ctx: HttpContext) {
    return this.decide(ctx, 'reject')
  }

  async revoke(ctx: HttpContext) {
    return this.decide(ctx, 'revoke')
  }

  private async decide(ctx: HttpContext, decision: 'approve' | 'reject' | 'revoke') {
    const actor = await ctx.auth.getUserOrFail()
    const service = await admission()
    const record = await service[decision]({
      actorId: actor.id,
      userId: userIdParam(ctx.params.id),
    })
    return ctx.response.ok({ userId: record.userId, approval: record.approval })
  }
}
`
}

function createUsersTable(usersTable: string, idType: UserIdType) {
  return `import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = '${usersTable}'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      ${primaryKey(idType)}
      table.string('full_name').notNullable()
      table.string('email', 254).notNullable().unique()
      table.string('password').notNullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
`
}

function createAccessTokensTable(usersTable: string, idType: UserIdType) {
  return `import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'auth_access_tokens'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      ${idColumn('tokenable_id', idType)}
        .notNullable()
        .references('id')
        .inTable('${usersTable}')
        .onDelete('CASCADE')

      table.string('type').notNullable()
      table.string('name').nullable()
      table.string('hash').notNullable()
      table.text('abilities').notNullable()
      table.timestamp('created_at')
      table.timestamp('updated_at')
      table.timestamp('last_used_at').nullable()
      table.timestamp('expires_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
`
}

function createRoleAssignments(usersTable: string, idType: UserIdType) {
  return `import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'role_assignments'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      ${idColumn('user_id', idType)}
        .notNullable()
        .references('${usersTable}.id')
        .onDelete('CASCADE')
      table.string('role').notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
`
}

function createNotificationsOutbox(usersTable: string, idType: UserIdType) {
  return `import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'account_kit_outbox'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      ${idColumn('user_id', idType)}
        .notNullable()
        .references('id')
        .inTable('${usersTable}')
        .onDelete('CASCADE')
      table.string('operation').notNullable()
      table.string('operation_id', 64).notNullable().unique()
      table.string('recipient_email', 254).notNullable()
      table.integer('attempts').notNullable().defaultTo(0)
      table.timestamp('sent_at').nullable()
      table.string('last_error', 64).nullable()
      table.timestamp('created_at').notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
`
}

function makeUserFullNameNullable(usersTable: string) {
  return `import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected usersTable = '${usersTable}'

  // Change only the constraint, in place. \`.alter()\` would also reset the column's type and
  // default, and on SQLite it rebuilds the users table.
  async up() {
    this.defer(async (db) => {
      await db
        .rawQuery(\`ALTER TABLE "\${this.usersTable}" ALTER COLUMN full_name DROP NOT NULL\`)
        .exec()
    })
  }

  async down() {
    const userWithMissingName = await this.db.from(this.usersTable).whereNull('full_name').first()

    if (userWithMissingName) {
      throw new Error(
        'Cannot restore required user names while users have NULL full_name; assign names explicitly before rolling back.'
      )
    }

    this.defer(async (db) => {
      await db
        .rawQuery(\`ALTER TABLE "\${this.usersTable}" ALTER COLUMN full_name SET NOT NULL\`)
        .exec()
    })
  }
}
`
}

/**
 * The app-owned example files for one schema variant, keyed by path relative to the example and
 * formatted with the example's Prettier config, so the default rendering is the committed file.
 */
export async function renderApiVariant(
  usersTable: string,
  userIdType: UserIdType
): Promise<Map<ApiVariantFile, string>> {
  if (!/^[a-z][a-z0-9_]*$/.test(usersTable))
    throw new Error(`Invalid users table name: ${usersTable}`)
  const sources: [ApiVariantFile, string][] = [
    ['app/models/user.ts', userModel(usersTable, userIdType)],
    ['app/controllers/admissions_controller.ts', admissionsController(userIdType)],
    [
      'database/migrations/1761885935168_create_users_table.ts',
      createUsersTable(usersTable, userIdType),
    ],
    [
      'database/migrations/1768620764696_create_access_tokens_table.ts',
      createAccessTokensTable(usersTable, userIdType),
    ],
    [
      'database/migrations/1791906000000_create_role_assignments.ts',
      createRoleAssignments(usersTable, userIdType),
    ],
    [
      'database/migrations/1800000000001_create_notifications_outbox.ts',
      createNotificationsOutbox(usersTable, userIdType),
    ],
    [
      'database/migrations/1800000000003_make_user_full_name_nullable.ts',
      makeUserFullNameNullable(usersTable),
    ],
  ]
  const rendered = new Map<ApiVariantFile, string>()
  for (const [path, source] of sources) {
    const filepath = join(exampleRoot, path)
    const options = await resolveConfig(filepath)
    rendered.set(path, await format(source, { ...options, filepath }))
  }
  return rendered
}
