import assert from 'node:assert/strict'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { Encryption } from '@adonisjs/core/encryption'
import { defineConfig as defineHashConfig, drivers } from '@adonisjs/core/hash'
import { defineConfig as defineLimiterConfig, stores } from '@adonisjs/limiter'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { DateTime } from 'luxon'
import { AccountKit, createLucidAdapter, defineConfig, PostCommitError } from 'adonisjs-account-kit'
import type { AccountUser, Invitation, Trx } from 'adonisjs-account-kit'
import {
  databaseClient,
  databaseName,
  NativeSqlite,
  postgresConnection,
  sqliteConnection,
} from './connection.js'
import { createSchema } from './schema.js'
import { runInvitationContention } from './invitation_contention.js'
import { runSqliteContention } from './sqlite_contention.js'

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
function requiredFullName(data: unknown): string {
  const fullName = (data as { fullName?: unknown } | null)?.fullName
  if (typeof fullName !== 'string' || fullName.trim() === '') {
    throw new Error('A full name is required')
  }
  return fullName.trim()
}

const modelAdapter = createLucidAdapter(async () => User, {
  mapRegistrationData(data, user) {
    user.fullName = requiredFullName(data)
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
      mapFields: (input) => ({ fullName: requiredFullName(input) }),
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

function tokenFromUrl(value: string | undefined): string {
  assert.ok(value)
  return decodeURIComponent(new URL(value).pathname.split('/').at(-1)!)
}

try {
  await createSchema(db)
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

  await runSqliteContention({ account, db, profile, NativeSqlite, databaseName })

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

  await runInvitationContention({
    account,
    db,
    profile,
    User,
    databaseName,
    tokenFromUrl,
    notifications,
  })
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
