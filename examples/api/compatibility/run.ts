import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { Encryption } from '@adonisjs/core/encryption'
import { defineConfig as defineHashConfig, drivers } from '@adonisjs/core/hash'
import { defineConfig as defineLimiterConfig, stores } from '@adonisjs/limiter'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { DateTime } from 'luxon'
import {
  AccountKit,
  createLucidAdapter,
  defineConfig,
  InvalidTokenError,
  PostCommitError,
} from 'adonisjs-account-kit'
import type { AccountUser, Invitation, Trx } from 'adonisjs-account-kit'

const databaseClient = process.env.DB_CONNECTION === 'postgres' ? 'pg' : 'better-sqlite3'
const databaseName = process.env.DB_CONNECTION === 'postgres' ? 'postgres' : 'sqlite'
const require = createRequire(import.meta.url)
interface NativeSqliteConnection {
  readonly inTransaction: boolean
  exec(sql: string): void
  close(): void
  pragma(sql: string): unknown
}
const NativeSqlite = require('better-sqlite3') as new (filename: string) => NativeSqliteConnection
const sqliteConnection = {
  client: 'better-sqlite3' as const,
  connection: { filename: 'compatibility.sqlite' },
  useNullAsDefault: true,
  pool: {
    min: 1,
    max: 1,
    afterCreate(
      connection: { pragma(sql: string): void },
      done: (error: Error | null, connection?: unknown) => void
    ) {
      connection.pragma('foreign_keys = ON')
      connection.pragma('busy_timeout = 1000')
      done(null, connection)
    },
  },
}
const postgresConnection = {
  client: 'pg' as const,
  connection: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? '55432'),
    user: process.env.DB_USER ?? 'account_kit',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'account_kit_consumer',
  },
  pool: { min: 1, max: 4 },
}

const factory = new IgnitorFactory()
  .withCoreProviders()
  .withCoreConfig()
  .merge({
    rcFileContents: {
      providers: [
        () => import('@adonisjs/lucid/database_provider'),
        () => import('@adonisjs/limiter/limiter_provider'),
      ],
    },
    config: {
      database: defineDatabaseConfig({
        connection: 'consumer',
        connections: {
          consumer: databaseClient === 'pg' ? postgresConnection : sqliteConnection,
        },
      }),
      limiter: defineLimiterConfig({
        default: 'memory',
        stores: { memory: stores.memory({}) },
      }),
      hash: defineHashConfig({
        default: 'scrypt',
        list: { scrypt: drivers.scrypt({ cost: 2 }) },
      }),
    },
  })

const ignitor = factory.create(new URL('./', import.meta.url))
const app = ignitor.createApp('console')
await app.init()
await app.boot()

const db = await app.container.make('lucid.db')
const encryption = await app.container.make(Encryption)
const limiter = await app.container.make('limiter.manager')
const [{ default: User }, { default: hash }] = await Promise.all([
  import('./user.js'),
  import('@adonisjs/core/services/hash'),
])
const modelAdapter = createLucidAdapter(async () => User, {
  mapRegistrationData(data, user) {
    const fullName = (data as { fullName?: unknown } | null)?.fullName
    if (typeof fullName !== 'string' || fullName.trim() === '') {
      throw new Error('A full name is required')
    }
    user.fullName = fullName.trim()
  },
})

const notifications: {
  passwordResetUrl?: string
  emailVerificationUrl?: string
  invitationUrl?: string
  emailChangeUrl?: string
} = {}
let failCredentialTransaction = false
let failPasswordNotice = false
let insertDeferredFailure = false
const account = new AccountKit({
  config: defineConfig({
    limiterSecret: 'minimum-consumer-test-secret-32-bytes-long',
    enabled: ['passwordReset', 'emailVerification', 'invitations', 'emailPasswordManagement'],
    registration: {
      availability: 'closed',
      mapFields: (input) => {
        const fullName = (input as { fullName?: unknown } | null)?.fullName
        if (typeof fullName !== 'string' || fullName.trim() === '') {
          throw new Error('A full name is required')
        }
        return { fullName: fullName.trim() }
      },
    },
    minRequestMs: 0,
    throttle: { requests: 100, duration: '15m' },
    invitationThrottle: {
      sendActor: { requests: 100, duration: '15m' },
      sendRecipient: { requests: 100, duration: '15m' },
      resendActor: { requests: 100, duration: '15m' },
      resendInvitation: { requests: 100, duration: '15m' },
    },
    users: modelAdapter,
    authorize: {
      invite: async () => true,
      manageInvitation: async () => true,
      listInvitations: async () => true,
    },
    urls: {
      passwordReset: (token) => `https://example.test/recovery/${token}`,
      emailVerification: (token) => `https://example.test/verification/${token}`,
      invitation: (token) => `https://example.test/invitation/${token}`,
      emailChange: (token) => `https://example.test/email-change/${token}`,
    },
    notify: {
      passwordResetProvision: async (_user, url) => {
        notifications.passwordResetUrl = url
      },
      accountActivationProvision: async (_user, url) => {
        notifications.emailVerificationUrl = url
      },
      invitationProvision: async (_invitation, url) => {
        notifications.invitationUrl = url
      },
      emailChangeProvision: async (_user, _email, url) => {
        notifications.emailChangeUrl = url
      },
      emailChanged: async () => {},
      passwordResetCompleted: async () => {
        if (failPasswordNotice) throw new Error('private delivery failure')
      },
      passwordChanged: async () => {},
    },
    onInvitationAccepted: async (user: AccountUser, invitation: Invitation, trx: Trx) => {
      await trx.table('role_assignments').insert({ user_id: user.id, role: invitation.role })
    },
    onCredentialsChangedTransaction: async (_user, context, trx) => {
      if (context.operation === 'password_reset' || context.operation === 'password_change') {
        await trx.table('account_kit_outbox').insert({ operation: context.operation })
      }
      if (insertDeferredFailure) {
        await trx.table('account_kit_deferred_failure').insert({ user_id: -1 })
      }
      if (failCredentialTransaction) throw new Error('transaction rollback sentinel')
    },
  }),
  db,
  encryption,
  limiter,
})

async function createSchema() {
  const schema = db.connection().schema
  await schema.dropTableIfExists('account_kit_deferred_failure')
  await schema.dropTableIfExists('role_assignments')
  await schema.dropTableIfExists('account_kit_outbox')
  await schema.dropTableIfExists('account_transaction_lock')
  await schema.dropTableIfExists('account_email_changes')
  await schema.dropTableIfExists('email_verification_tokens')
  await schema.dropTableIfExists('account_invitations')
  await schema.dropTableIfExists('password_reset_tokens')
  await schema.dropTableIfExists('users')

  await schema.createTable('users', (table) => {
    table.increments('id').primary()
    table.string('full_name').notNullable()
    table.string('email').notNullable().unique()
    table.string('unverified_email').nullable()
    table.string('password').nullable()
    table.timestamp('email_verified_at').nullable()
    table.timestamp('created_at').notNullable()
  })
  await schema.createTable('password_reset_tokens', (table) => {
    table.increments('id').primary()
    table.integer('tokenable_id').notNullable().unique()
    table.string('email').notNullable()
    table.string('hash').notNullable().unique()
    table.timestamp('expires_at').notNullable()
    table.timestamp('created_at').notNullable()
  })
  await schema.createTable('account_invitations', (table) => {
    table.increments('id').primary()
    table.string('email').notNullable()
    table.string('role').notNullable()
    table.integer('inviter_id').nullable()
    table.string('token_hash').notNullable().unique()
    table.timestamp('expires_at').notNullable()
    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()
  })
  await schema.createTable('email_verification_tokens', (table) => {
    table.increments('id').primary()
    table.integer('tokenable_id').notNullable().unique()
    table.string('email').notNullable()
    table.string('current_email').notNullable()
    table.string('purpose').notNullable()
    table.string('hash').notNullable().unique()
    table.timestamp('expires_at').notNullable()
    table.timestamp('created_at').notNullable()
  })
  await schema.createTable('account_transaction_lock', (table) => {
    table.integer('id').primary()
    table.integer('version').notNullable()
  })
  await schema.createTable('account_kit_outbox', (table) => {
    table.increments('id').primary()
    table.string('operation').notNullable()
  })
  await schema.createTable('role_assignments', (table) => {
    table.increments('id').primary()
    table.integer('user_id').notNullable()
    table.string('role').notNullable()
  })
  if (databaseName === 'postgres') {
    await db
      .rawQuery(
        'CREATE TABLE account_kit_deferred_failure (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id integer REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)'
      )
      .exec()
  } else {
    await db
      .rawQuery(
        'CREATE TABLE account_kit_deferred_failure (id integer PRIMARY KEY AUTOINCREMENT, user_id integer, FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)'
      )
      .exec()
  }
  await db.table('account_transaction_lock').insert({ id: 1, version: 0 })
  assert.ok(await db.from('account_transaction_lock').where('id', 1).first())
  const returningResult = await db
    .rawQuery('update account_transaction_lock set version = version where id = 1 returning id')
    .exec()
  console.log(
    `MINIMUM_LUCID_RETURNING_SHAPE ${JSON.stringify({
      dialect: databaseName,
      isArray: Array.isArray(returningResult),
      keys:
        typeof returningResult === 'object' && returningResult !== null
          ? Object.keys(returningResult)
          : [],
    })}`
  )
  const probeTrx = await db.connection().transaction()
  try {
    const transactionalReturningResult = await probeTrx
      .rawQuery('update account_transaction_lock set version = version where id = 1 returning id')
      .exec()
    console.log(
      `MINIMUM_LUCID_TRANSACTION_RETURNING_SHAPE ${JSON.stringify({
        dialect: databaseName,
        isArray: Array.isArray(transactionalReturningResult),
        keys:
          typeof transactionalReturningResult === 'object' && transactionalReturningResult !== null
            ? Object.keys(transactionalReturningResult)
            : [],
        rows: Array.isArray(transactionalReturningResult)
          ? transactionalReturningResult.length
          : 'not-array',
      })}`
    )
  } finally {
    await probeTrx.rollback()
  }
  if (databaseName === 'sqlite') {
    const sqliteClient = db.connection().getWriteClient().client
    const nativeSqlite = await sqliteClient.acquireConnection()
    const priorTimeout = Number(nativeSqlite.pragma('busy_timeout', { simple: true }))
    nativeSqlite.pragma('busy_timeout = 0')
    const sqliteProbeTrx = (await db
      .connection()
      .transaction(undefined as never, { connection: nativeSqlite } as never)) as Trx
    try {
      const result = await sqliteProbeTrx
        .rawQuery('update account_transaction_lock set version = version where id = 1 returning id')
        .exec()
      console.log(
        `MINIMUM_LUCID_PINNED_CONNECTION_RETURNING_SHAPE ${JSON.stringify({
          dialect: databaseName,
          isArray: Array.isArray(result),
          rows: Array.isArray(result) ? result.length : 'not-array',
        })}`
      )
    } finally {
      await sqliteProbeTrx.rollback()
      if (nativeSqlite.inTransaction) nativeSqlite.exec('ROLLBACK')
      nativeSqlite.pragma(`busy_timeout = ${priorTimeout}`)
      await sqliteClient.releaseConnection(nativeSqlite)
    }
  }
}

function tokenFromUrl(value: string | undefined): string {
  assert.ok(value)
  return decodeURIComponent(new URL(value).pathname.split('/').at(-1)!)
}

try {
  await createSchema()
  console.log('MINIMUM_STAGE schema-ready')
  const profile = await User.create({
    fullName: 'Compatibility Owner',
    email: ' Owner@Example.Test ',
    password: 'OwnerPass123!',
    emailVerifiedAt: DateTime.utc(),
  })
  assert.equal(profile.email, 'owner@example.test')
  console.log('MINIMUM_STAGE user-created')
  const metadata = await modelAdapter.resolveMetadata()
  const foundOwner = await modelAdapter.findByEmail(' OWNER@example.test ')
  assert.equal(metadata.table, process.env.ACCOUNT_KIT_USERS_TABLE ?? 'users')
  assert.equal(foundOwner?.id, profile.id)

  if (databaseName === 'sqlite') {
    const writer = new NativeSqlite('compatibility.sqlite')
    writer.pragma('busy_timeout = 0')
    writer.exec('BEGIN IMMEDIATE')
    let busyLockAttempts = 0
    const sqliteClient = db.connection().getWriteClient().client
    const countBusyLockAttempt = (query: { sql?: string }) => {
      if (/^update account_transaction_lock/i.test(query.sql ?? '')) busyLockAttempts += 1
    }
    sqliteClient.on('query', countBusyLockAttempt)
    const startedAt = performance.now()
    const releaseWriter = setTimeout(() => {
      if (writer.inTransaction) writer.exec('COMMIT')
      writer.close()
    }, 60)
    try {
      await account.passwordReset.request({
        email: profile.email,
        clientKey: 'sqlite-retry-client',
      })
    } finally {
      clearTimeout(releaseWriter)
      if (writer.inTransaction) writer.exec('COMMIT')
      writer.close()
      sqliteClient.off('query', countBusyLockAttempt)
    }
    const elapsedMs = Math.round(performance.now() - startedAt)
    assert.ok(busyLockAttempts >= 2, `expected a busy lock retry, observed ${busyLockAttempts}`)
    assert.ok(
      elapsedMs >= 40,
      `expected the writer lock to delay the operation, observed ${elapsedMs}ms`
    )
    console.log(
      `MINIMUM_SQLITE_RETRY_SMOKE ${JSON.stringify({ elapsedMs, busyLockAttempts, lockReleasedAfterMs: 60 })}`
    )
  }

  await account.passwordReset.request({ email: profile.email, clientKey: 'consumer-client' })
  console.log('MINIMUM_STAGE password-reset-requested')
  const recoveryToken = tokenFromUrl(notifications.passwordResetUrl)
  assert.equal(await account.passwordReset.inspect({ token: recoveryToken }), true)
  failCredentialTransaction = true
  await assert.rejects(
    account.passwordReset.reset({ token: recoveryToken, password: 'RolledBackPass123!' }),
    /transaction rollback sentinel/
  )
  failCredentialTransaction = false
  console.log('MINIMUM_STAGE rollback-verified')
  assert.equal(await account.passwordReset.inspect({ token: recoveryToken }), true)
  assert.equal(
    await db
      .from('account_kit_outbox')
      .count('* as count')
      .then((rows) => Number(rows[0].count)),
    0
  )

  failPasswordNotice = true
  await assert.rejects(
    account.passwordReset.reset({ token: recoveryToken, password: 'CommittedPass123!' }),
    PostCommitError
  )
  failPasswordNotice = false
  console.log('MINIMUM_STAGE post-commit-verified')
  await profile.refresh()
  assert.equal(await hashVerify(profile.password, 'CommittedPass123!'), true)
  const recoveryRemainsActive = await account.passwordReset.inspect({ token: recoveryToken })
  assert.equal(recoveryRemainsActive, false)
  const committedOutbox = await db.from('account_kit_outbox').count('* as count').first()
  assert.equal(Number(committedOutbox.count), 1)

  const unverifiedUser = await User.create({
    fullName: 'Verification User',
    email: 'verification@example.test',
    password: 'VerifyPass123!',
    emailVerifiedAt: null,
    unverifiedEmail: 'verification@example.test',
  })
  assert.equal(await account.emailVerification.send({ userId: unverifiedUser.id }), 'sent')
  const verificationToken = tokenFromUrl(notifications.emailVerificationUrl)
  assert.equal(
    await account.emailVerification.complete({
      token: verificationToken,
      password: 'NewPassword123',
    }),
    'verified'
  )
  await assert.rejects(() =>
    account.emailVerification.complete({ token: verificationToken, password: 'NewPassword123' })
  )
  await unverifiedUser.refresh()
  assert.ok(unverifiedUser.emailVerifiedAt)
  console.log('MINIMUM_STAGE email-verification-send-complete-verified-replay')

  await account.emailPasswordManagement.changePassword({
    actorId: profile.id,
    currentPassword: 'CommittedPass123!',
    newPassword: 'ChangedPass123!',
  })
  await profile.refresh()
  assert.equal(await hashVerify(profile.password, 'ChangedPass123!'), true)
  const passwordChangeOutboxCount = await db
    .from('account_kit_outbox')
    .where('operation', 'password_change')
    .count('* as count')
    .first()
  assert.equal(Number(passwordChangeOutboxCount.count), 1)
  console.log('MINIMUM_STAGE authenticated-password-change')

  await account.emailPasswordManagement.requestEmailChange({
    actorId: profile.id,
    currentPassword: 'ChangedPass123!',
    newEmail: ' Owner-Next@Example.Test ',
  })
  const emailChangeToken = tokenFromUrl(notifications.emailChangeUrl)
  const changedProfile = await account.emailPasswordManagement.completeEmailChange({
    token: emailChangeToken,
  })
  assert.equal(changedProfile.email, 'owner-next@example.test')
  assert.ok(changedProfile.emailVerifiedAt)
  const emailChangeOutboxCount = await db
    .from('account_kit_outbox')
    .where('operation', 'email_change')
    .count('* as count')
    .first()
  assert.equal(Number(emailChangeOutboxCount.count), 0)
  console.log('MINIMUM_STAGE authenticated-email-change')
  console.log(
    `MINIMUM_PUBLIC_OPERATIONS ${JSON.stringify(['passwordReset', 'emailVerification', 'password_change', 'email_change', 'invitations'])}`
  )

  {
    const deferredUser = await User.create({
      fullName: 'Deferred User',
      email: 'deferred@example.test',
      password: 'DeferredPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    await account.passwordReset.request({ email: deferredUser.email, clientKey: 'deferred-client' })
    console.log('MINIMUM_STAGE deferred-requested')
    const deferredToken = tokenFromUrl(notifications.passwordResetUrl)
    insertDeferredFailure = true
    await assert.rejects(
      account.passwordReset.reset({ token: deferredToken, password: 'NeverCommitted123!' })
    )
    insertDeferredFailure = false
    assert.equal(await account.passwordReset.inspect({ token: deferredToken }), true)
    await deferredUser.refresh()
    assert.equal(await hashVerify(deferredUser.password, 'DeferredPass123!'), true)
    console.log('MINIMUM_STAGE deferred-commit-verified')
  }

  const startedAt = performance.now()
  const invitation = await account.invitations.send({
    actorId: profile.id,
    email: 'invited@example.test',
    role: 'member',
  })
  console.log('MINIMUM_STAGE invitation-sent')
  assert.ok(invitation.id > 0)
  const invitationToken = tokenFromUrl(notifications.invitationUrl)
  const accepts = await Promise.allSettled([
    account.invitations.accept({
      token: invitationToken,
      password: 'InvitedPass123!',
      registrationData: { fullName: 'Invited Member' },
    }),
    account.invitations.accept({
      token: invitationToken,
      password: 'InvitedPass123!',
      registrationData: { fullName: 'Invited Member' },
    }),
  ])
  console.log('MINIMUM_STAGE contention-complete')
  const elapsedMs = Math.round(performance.now() - startedAt)
  assert.equal(accepts.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = accepts.find((result) => result.status === 'rejected')
  assert.equal(rejected?.status, 'rejected')
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof InvalidTokenError)
  const invited = await User.findByOrFail('email', 'invited@example.test')
  const invitedName = invited.fullName
  assert.equal(invitedName, 'Invited Member')
  const roleAssignmentCount = await db.from('role_assignments').count('* as count').first()
  assert.equal(Number(roleAssignmentCount.count), 1)
  console.log(
    `MINIMUM_CONTENTION_SMOKE ${JSON.stringify({ database: databaseName, elapsedMs, fulfilled: 1, rejected: 1 })}`
  )
  console.log(
    `MINIMUM_TRANSACTION_SEMANTICS ${JSON.stringify({ database: databaseName, rollback: true, postCommit: true, deferredCommit: true, locking: true, sqliteBusyRetry: databaseName === 'sqlite' })}`
  )
} finally {
  await ignitor.terminate()
}

async function hashVerify(stored: string | null, password: string): Promise<boolean> {
  if (!stored) return false
  return hash.verify(stored, password)
}
