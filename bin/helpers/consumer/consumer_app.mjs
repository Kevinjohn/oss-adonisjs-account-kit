import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './harness.mjs'
import { userIdType, usersTable } from './settings.mjs'
export { databaseEnvironment } from './consumer_environment.mjs'
export { installArchive } from './consumer_archive.mjs'

export async function packageMigrations(appRoot) {
  const dir = join(appRoot, 'database/migrations')
  return (await readdir(dir))
    .filter((file) => file.includes('_account_kit_'))
    .map((file) => join(dir, file))
}

export async function configure(appRoot, env) {
  run(
    'pnpm',
    [
      'exec',
      'node',
      'ace',
      'configure',
      'adonisjs-account-kit',
      '--users-table',
      usersTable,
      '--user-id-type',
      userIdType,
    ],
    appRoot,
    env
  )
}

export async function adaptGeneratedUserSchema(appRoot) {
  const schemaPath = join(appRoot, 'database/schema.ts')
  const modelPath = join(appRoot, 'app/models/user.ts')
  const schema = await readFile(schemaPath, 'utf8')
  const classes = [
    ...schema.matchAll(
      /export class (\w+Schema) extends BaseModel \{([\s\S]*?)(?=\nexport class |\n\})/g
    ),
  ]
  const userSchema = classes.find(([, , body]) => {
    const columns = body.match(/static \$columns = \[([\s\S]*?)\] as const/)?.[1] ?? ''
    return ['email', 'fullName', 'id'].every((column) =>
      new RegExp(`['"]${column}['"]`).test(columns)
    )
  })?.[1]
  if (!userSchema)
    throw new Error('Codegen did not emit a user schema with email, fullName, and id')
  const model = await readFile(modelPath, 'utf8')
  const updated = model.replace(
    /import \{ \w+Schema(?: as UserSchema)? \} from '#database\/schema'/,
    `import { ${userSchema} as UserSchema } from '#database/schema'`
  )
  if (updated === model && !model.includes(`import { ${userSchema} as UserSchema }`)) {
    throw new Error('Could not align the example model with the generated user schema')
  }
  await writeFile(modelPath, updated)
}
