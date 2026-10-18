import { test } from '@japa/runner'
import { createPrismaAdapter, type PrismaModelDefinition } from '../adapters/prisma.js'
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

  test('validates the model on first use, naming the problem', async ({ assert }) => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /expects a Prisma DMMF model/],
      [
        withField('unverifiedEmail', { dbName: null }),
        /map the unverifiedEmail field to the unverified_email column/,
      ],
      [
        withField('emailVerifiedAt', null),
        /map the emailVerifiedAt field to the email_verified_at column/,
      ],
      [withField('password', { kind: 'object' }), /map the password field to the password column/],
      [withField('id', { dbName: 'user_id' }), /map the id field to the id column/],
      [{ ...appUser, dbName: 'app-users' }, /plain SQL identifier/],
    ]
    for (const [model, message] of cases) {
      const adapter = createPrismaAdapter(model as PrismaModelDefinition, { db: kit.db })
      await assert.rejects(() => adapter.resolveMetadata(), message)
      await assert.rejects(() => adapter.findByEmail('a@example.test'), message)
    }
  })
})
