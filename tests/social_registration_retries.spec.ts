import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
import { makeService, makeUsersAdapter } from './helpers/fakes.js'
import { clientChallenge, provider } from './helpers/social_identity.js'
import { locksRows } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'
import type { LifecycleEvent, Trx } from '../src/types.js'

test.group('social registration SQLite retries', () => {
  for (const entry of ['callback', 'continuation'] as const) {
    for (const verified of [false, true]) {
      test(`${entry}: a busy commit cannot leak ${verified ? 'invitation' : 'activation'} follow-ups from a rolled-back signup`, async ({
        assert,
      }) => {
        const kit = await bootTestApp({ sqlitePoolMax: 2 })
        let reader: Trx | undefined
        let busyCommits = 0
        let attempts = 0
        const listeners: Array<() => void> = []
        try {
          await resetSchema(kit)
          await kit.db.rawQuery('PRAGMA journal_mode = DELETE').exec()
          const users = makeUsersAdapter(kit.db, kit.hash)
          const events: LifecycleEvent[] = []
          const { account, recorder } = makeService(kit, {
            users: {
              ...users,
              async create(attrs, trx) {
                attempts++
                const emitter = trx.getWriteClient()
                const onError = (error: { code?: string }, query: { sql?: string }) => {
                  if (/^\s*commit\b/i.test(query.sql ?? '') && error.code === 'SQLITE_BUSY')
                    busyCommits++
                }
                emitter.on('query-error', onError)
                listeners.push(() => emitter.off('query-error', onError))
                trx.after('rollback', async () => {
                  await reader!.commit()
                  await kit.db.table('users').insert({
                    email: 'race@example.test',
                    password: null,
                    unverified_email: 'race@example.test',
                    email_verified_at: null,
                    created_at: dbTime(kit),
                  })
                })
                return users.create(attrs, trx)
              },
            },
            enabled: ['socialAuthentication', 'emailVerification', 'invitations'],
            registration: {
              availability: 'open',
              ...(entry === 'continuation' ? { mapFields: () => ({}) } : {}),
            },
            authentication: { strategy: 'session', guard: 'web' },
            socialAuthentication: {
              providers: { github: provider('race-subject', 'race@example.test', verified) },
            },
            onLifecycleEvent: async (event) => {
              events.push(event)
            },
          })
          await account.operator.invite({
            email: 'race@example.test',
            role: 'member',
            deliver: 'print',
          })
          events.length = 0
          const start = await account.socialAuthentication.begin({
            provider: 'github',
            intent: 'login',
            clientChallenge,
          })
          let signup = () =>
            account.socialAuthentication.callback({ state: start.state, callback: {} })
          if (entry === 'continuation') {
            const pending = await signup()
            if (!('continuation' in pending) || !pending.continuation)
              throw new Error('Missing continuation')
            const continuation = pending.continuation
            signup = () => account.socialAuthentication.completeRegistration({ continuation })
          }
          reader = await kit.db.transaction()
          await reader.from('users').first()
          const result = await signup()
          assert.deepEqual(result, { status: 'link_required' })
          assert.equal(attempts, 1)
          assert.equal(busyCommits, 1)
          assert.lengthOf(await kit.db.from('users'), 1)
          assert.lengthOf(await kit.db.from('social_identities'), 0)
          assert.lengthOf(await kit.db.from('account_invitations'), 1)
          assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
          assert.lengthOf(recorder.calls, 0)
          assert.lengthOf(events, 0)
        } finally {
          for (const remove of listeners) remove()
          if (reader && !reader.isCompleted) await reader.rollback()
          await kit.close()
        }
      })
        .skip(locksRows, 'Requires SQLite DELETE-journal commit contention')
        .timeout(10_000)
    }
  }
})
