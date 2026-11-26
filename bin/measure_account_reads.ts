import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createLucidAdapter } from '../src/adapters/lucid.js'
import { createSqlUsersAdapter } from '../src/adapters/sql.js'
import LucidUser from '../tests/helpers/lucid_user.js'
import { allowDecisions, makeAdmission } from '../tests/helpers/admission.js'
import { createAdmissionTable } from '../tests/helpers/admission_schema.js'
import { bootTestApp, type TestApp } from '../tests/helpers/app.js'
import { dbTime } from '../tests/helpers/db_time.js'
import { makeService } from '../tests/helpers/fakes.js'
import { resetSchema } from '../tests/helpers/schema.js'
import { testClient } from '../tests/helpers/test_connection.js'

const warmups = 5
const samples = 30
const accountCount = 1001
const admissionCount = 100

async function seed(kit: TestApp) {
  await resetSchema(kit)
  await createAdmissionTable(kit)
  const now = dbTime(kit, '2026-01-01T00:00:00Z')
  for (let first = 1; first <= accountCount; first += 100) {
    const size = Math.min(100, accountCount - first + 1)
    await kit.db.table('users').insert(
      Array.from({ length: size }, (_, index) => {
        const id = first + index
        return {
          id,
          email: `account-${id}@example.test`,
          password: id === accountCount ? null : 'unused-fixture-hash',
          created_at: now,
        }
      })
    )
  }
  await kit.db.table('account_admissions').insert(
    Array.from({ length: admissionCount }, (_, index) => ({
      user_id: index + 1,
      approval_status: index === 0 ? 'approved' : null,
      approval_decided_at: index === 0 ? now : null,
      created_at: now,
      updated_at: now,
    }))
  )
  await kit.db.table('social_identities').insert({
    user_id: accountCount,
    provider: 'google',
    provider_user_id: 'fixture-google-id',
    email: `account-${accountCount}@example.test`,
    email_verified: true,
    confirmed_at: now,
    created_at: now,
    updated_at: now,
  })
}

async function measure<Result>(
  kit: TestApp,
  scenario: string,
  run: () => Promise<Result>,
  verify: (result: Result) => void
) {
  const knex = kit.db.connection().getWriteClient()
  let statements = 0
  const countQuery = () => statements++
  const counts = new Set<number>()
  const elapsed: number[] = []
  knex.on('query', countQuery)
  try {
    for (let index = 0; index < warmups + samples; index++) {
      statements = 0
      const start = performance.now()
      const result = await run()
      const duration = performance.now() - start
      verify(result)
      if (index >= warmups) {
        elapsed.push(duration)
        counts.add(statements)
      }
    }
  } finally {
    knex.off('query', countQuery)
  }
  const sorted = elapsed.toSorted((a, b) => a - b)
  const median = (sorted[samples / 2 - 1] + sorted[samples / 2]) / 2
  return {
    scenario,
    'statements': [...counts].toSorted((a, b) => a - b).join(', '),
    'median (ms)': median.toFixed(2),
    'p95 (ms)': sorted[Math.ceil(samples * 0.95) - 1].toFixed(2),
  }
}

const client = testClient()
if (client === 'mysql2')
  throw new Error('The measurement requires a temporary SQLite or PostgreSQL fixture')
// Use a fresh schema so the fixture can run beside other PostgreSQL checks.
const postgresSchema = `account_schema_fixture_${randomUUID().replaceAll('-', '')}`
const kit = await bootTestApp(client === 'pg' ? { postgresSchema } : {})
try {
  await seed(kit)
  const { admission } = makeAdmission(
    kit,
    { approval: { required: true, authorize: allowDecisions } },
    { users: createSqlUsersAdapter({ table: 'users', db: kit.db }) }
  )
  const { account } = makeService(kit, {
    users: createLucidAdapter(async () => LucidUser),
    authentication: { strategy: 'session', guard: 'web' },
    enabled: ['socialAuthentication', 'emailVerification'],
    socialAuthentication: {
      providers: {
        google: {
          authorizationUrl: async () => 'https://provider.example',
          resolve: async () => ({
            subject: 'fixture-google-id',
            email: null,
            emailVerified: false,
          }),
        },
      },
    },
  })
  const results = []
  for (const limit of [admissionCount, 1]) {
    results.push(
      await measure(
        kit,
        `SQL admission (limit ${limit})`,
        () => admission.list({ actorId: 1, limit }),
        ({ items, nextCursor }) => {
          assert.equal(items.length, limit)
          assert.equal(nextCursor === null, limit === admissionCount)
        }
      )
    )
  }
  results.push(
    await measure(
      kit,
      'Lucid password retirement (keep Google)',
      () =>
        account.authentication.retirementImpact({ passwordLogin: false, providers: ['google'] }),
      ({ inspectedAccounts, affectedAccounts }) => {
        assert.equal(inspectedAccounts, accountCount)
        assert.equal(affectedAccounts, accountCount - 1)
      }
    )
  )
  console.log(
    `${client}, ${accountCount} users, ${warmups} warmups and ${samples} samples per case`
  )
  console.table(results)
} finally {
  await kit.close()
}
