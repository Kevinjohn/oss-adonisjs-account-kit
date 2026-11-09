import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { format, resolveConfig } from 'prettier'
import { migrationNames, migrationSchema } from '../configure.js'
import {
  apiVariantFiles,
  exampleRoot,
  renderApiVariant,
} from '../bin/helpers/consumer/api_variants.js'

const stubsRoot = fileURLToPath(new URL('../stubs/migrations/', import.meta.url))
const exampleMigrations = join(exampleRoot, 'database/migrations')

/** The package migrations the example commits, by filename, and the stub each one came from. */
const packageMigrations = [
  ...migrationNames.map((name) => [`account_kit_${name}`, name] as const),
  ['account_kit_admission_create_account_admissions', 'create_account_admissions'] as const,
]

/** Render a migration stub for the defaults the way configure does, then format as the example does. */
async function renderDefaultStub(name: string, filepath: string) {
  const stub = await readFile(join(stubsRoot, `${name}.stub`), 'utf8')
  const schema = migrationSchema('users', 'integer')
  const body = Object.entries(schema).reduce(
    (text, [key, value]) => text.replaceAll(`{{{ migration.${key} }}}`, value),
    stub.replace(/^\{\{\{ exports\([^\n]+\n\n/, '')
  )
  if (body.includes('{{{')) throw new Error(`Unreplaced placeholder in ${name}.stub`)
  const options = await resolveConfig(filepath)
  return format(body.trim() + '\n', { ...options, filepath })
}

// The committed example is the default rendering, so a change to either side fails here instead
// of drifting quietly until a consumer run.
test('the committed API example is the default rendering of its app-owned files', async ({
  assert,
}) => {
  const rendered = await renderApiVariant('users', 'integer')
  assert.sameMembers([...rendered.keys()], [...apiVariantFiles])
  for (const [path, contents] of rendered) {
    assert.equal(await readFile(join(exampleRoot, path), 'utf8'), contents, path)
  }
})

test('the committed API example package migrations are the default configure output', async ({
  assert,
}) => {
  const committed = await readdir(exampleMigrations)
  for (const [suffix, stub] of packageMigrations) {
    const [match, ...extra] = committed.filter((name) => name.endsWith(`_${suffix}.ts`))
    assert.isDefined(match, `${suffix} is committed once`)
    assert.deepEqual(extra, [], `${suffix} is committed once`)
    const filepath = join(exampleMigrations, match!)
    assert.equal(await readFile(filepath, 'utf8'), await renderDefaultStub(stub, filepath), match)
  }
})

test('non-default variants change the users table, the ID columns and the model', async ({
  assert,
}) => {
  // Prettier wraps long call chains, so compare with whitespace removed.
  const flat = (rendered: Map<string, string>, path: string) =>
    rendered.get(path)!.replace(/\s+/g, '')
  const strings = await renderApiVariant('account_users', 'string')
  const users = flat(strings, 'database/migrations/1761885935168_create_users_table.ts')
  assert.include(users, "tableName='account_users'")
  assert.include(users, "table.string('id').primary().notNullable()")
  assert.include(
    flat(strings, 'database/migrations/1768620764696_create_access_tokens_table.ts'),
    "table.string('tokenable_id').notNullable().references('id').inTable('account_users')"
  )
  assert.include(
    flat(strings, 'database/migrations/1791906000000_create_role_assignments.ts'),
    ".references('account_users.id')"
  )
  assert.include(
    flat(strings, 'database/migrations/1800000000003_make_user_full_name_nullable.ts'),
    "usersTable='account_users'"
  )
  const model = flat(strings, 'app/models/user.ts')
  assert.include(model, "statictable='account_users'")
  assert.include(model, 'staticselfAssignPrimaryKey=true')
  assert.include(model, 'Object.assign(user,{id:randomUUID()})')
  const controller = flat(strings, 'app/controllers/admissions_controller.ts')
  assert.include(controller, 'functionuserIdParam(value:string):string')
  assert.notInclude(controller, 'Number.isSafeInteger')

  const uuids = await renderApiVariant('users', 'uuid')
  assert.include(
    flat(uuids, 'database/migrations/1761885935168_create_users_table.ts'),
    "table.uuid('id').primary().notNullable()"
  )
  assert.include(
    flat(uuids, 'database/migrations/1800000000001_create_notifications_outbox.ts'),
    "table.uuid('user_id').notNullable().references('id').inTable('users')"
  )
  assert.notInclude(flat(uuids, 'app/models/user.ts'), 'statictable=')

  await assert.rejects(() => renderApiVariant('Account Users', 'integer'), /Invalid users table/)
})
