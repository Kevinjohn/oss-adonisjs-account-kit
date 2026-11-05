import { test } from '@japa/runner'
import { createPrismaAdapter, type PrismaModelDefinition } from '../adapters/prisma.js'
import { InvalidConfigurationError } from '../src/errors.js'
import { assertUsersAdapterContract } from '../testing/adapter_contract.js'
import { useTestApp } from './helpers/app.js'
import { createAppUsersTable } from './helpers/app_users_table.js'
import { contractFixture, fakeHash } from './helpers/adapter_contract_fixture.js'

/** The DMMF shape of `model AppUser { ... @@map("app_users") }` with `@map` on each column. */
const appUser: PrismaModelDefinition = {
  name: 'AppUser',
  dbName: 'app_users',
  fields: [
    { name: 'id', kind: 'scalar' },
    { name: 'email', kind: 'scalar' },
    { name: 'unverifiedEmail', dbName: 'unverified_email', kind: 'scalar' },
    { name: 'password', kind: 'scalar' },
    { name: 'emailVerifiedAt', dbName: 'email_verified_at', kind: 'scalar' },
    { name: 'fullName', dbName: 'full_name', kind: 'scalar' },
    { name: 'posts', kind: 'object' },
  ],
}

const withField = (name: string, field: { dbName?: string | null; kind?: string } | null) => ({
  ...appUser,
  fields: appUser.fields.flatMap((candidate) =>
    candidate.name !== name ? [candidate] : field ? [{ ...candidate, ...field }] : []
  ),
})

test.group('Prisma users adapter', (group) => {
  const kit = useTestApp(group)
  group.each.setup(async () => {
    await createAppUsersTable(kit, 'app_users')
    await createAppUsersTable(kit, 'AppUser')
  })

  test('passes the adapter contract with a mapped model', async ({ assert }) => {
    const adapter = createPrismaAdapter(appUser, {
      ...fakeHash,
      db: kit.db,
      mapRegistrationData: (data) => ({ full_name: (data as { fullName: string }).fullName }),
    })
    assert.deepEqual(await adapter.resolveMetadata(), { table: 'app_users', primaryKey: 'id' })
    await assertUsersAdapterContract(
      contractFixture(kit, adapter, {
        table: 'app_users',
        registrationData: { fullName: 'Prisma User' },
      })
    )
  })

  test('an unmapped model uses its name as the table', async ({ assert }) => {
    const adapter = createPrismaAdapter({ ...appUser, dbName: null }, { db: kit.db })
    assert.deepEqual(await adapter.resolveMetadata(), { table: 'AppUser', primaryKey: 'id' })
  })

  test('model getters remain lazy and their faults are not configuration errors', async ({
    assert,
  }) => {
    const fault = new Error('Prisma model getter failed')
    let reads = 0
    const model = Object.defineProperty({ ...appUser }, 'fields', {
      get() {
        reads++
        throw fault
      },
    })
    const adapter = createPrismaAdapter(model, { db: kit.db })
    assert.equal(reads, 0)
    assert.strictEqual(await adapter.resolveMetadata().catch((caught: unknown) => caught), fault)
    assert.equal(reads, 1)
    const databaseFault = new Error('Prisma database factory failed')
    const valid = createPrismaAdapter(appUser, {
      db: async () => {
        throw databaseFault
      },
    })
    assert.deepEqual(await valid.resolveMetadata(), { table: 'app_users', primaryKey: 'id' })
    assert.strictEqual(await valid.findById(1).catch((caught: unknown) => caught), databaseFault)
  })

  test('validates the model on first use, naming the problem', async ({ assert }) => {
    const cases: Array<[unknown, RegExp, string]> = [
      [{}, /expects a Prisma DMMF model/, 'model'],
      [
        withField('unverifiedEmail', { dbName: null }),
        /map the unverifiedEmail field to the unverified_email column/,
        'model.fields.unverifiedEmail',
      ],
      [
        withField('emailVerifiedAt', null),
        /map the emailVerifiedAt field to the email_verified_at column/,
        'model.fields.emailVerifiedAt',
      ],
      [
        withField('password', { kind: 'object' }),
        /map the password field to the password column/,
        'model.fields.password',
      ],
      [
        withField('id', { dbName: 'user_id' }),
        /map the id field to the id column/,
        'model.fields.id',
      ],
      [{ ...appUser, dbName: 'app-users' }, /plain SQL identifier/, 'table'],
    ]
    for (const [model, message, field] of cases) {
      const adapter = createPrismaAdapter(model as PrismaModelDefinition, { db: kit.db })
      for (const run of [
        () => adapter.resolveMetadata(),
        () => adapter.findByEmail('a@example.test'),
      ]) {
        const error = await run().catch((caught: unknown) => caught)
        assert.instanceOf(error, InvalidConfigurationError)
        assert.equal(
          (error as InvalidConfigurationError).code,
          'E_ACCOUNT_KIT_INVALID_CONFIGURATION'
        )
        assert.equal((error as InvalidConfigurationError).field, field)
        assert.match((error as Error).message, message)
        assert.isUndefined((error as Error).cause)
      }
    }
  })
})
