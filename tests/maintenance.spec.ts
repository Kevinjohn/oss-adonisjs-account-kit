import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { Kernel, ListLoader } from '@adonisjs/core/ace'
import type { Database } from '@adonisjs/lucid/database'
import PruneAccountKit from '../commands/prune.js'
import { pruneExpired } from '../src/maintenance.js'
import { useTestApp } from './helpers/app.js'
import { insertUser } from './helpers/fakes.js'

test.group('expired-token pruning', (group) => {
  const kit = useTestApp(group)

  test('Ace command reports social cleanup in dry-run and deletion', async ({ assert }) => {
    const user = await insertUser(kit)
    const expired = '2020-01-01T00:00:00.000Z'
    await kit.db.table('social_transactions').insert({
      hash: 'a'.repeat(64),
      provider: 'google',
      intent: 'login',
      client_challenge: 'A'.repeat(43),
      expires_at: expired,
      created_at: expired,
    })
    await kit.db.table('social_sensitive_proofs').insert({
      hash: 'b'.repeat(64),
      user_id: user.id,
      purpose: 'social_link',
      expires_at: expired,
      created_at: expired,
    })
    await kit.db.table('social_identities').insert({
      user_id: user.id,
      provider: 'google',
      provider_user_id: 'prune-command-subject',
      email_verified: false,
      created_at: expired,
      updated_at: expired,
    })
    const identity = await kit.db.from('social_identities').firstOrFail()
    await kit.db.table('social_handoff_codes').insert({
      hash: 'c'.repeat(64),
      user_id: user.id,
      social_identity_id: identity.id,
      client_challenge: 'A'.repeat(43),
      expires_at: expired,
      created_at: expired,
    })

    const kernel = new Kernel(kit.app)
    kernel.addLoader(new ListLoader([PruneAccountKit]))
    const messages: string[] = []
    kernel.ui.logger.info = (message) => {
      messages.push(message)
    }
    const suffix =
      'recovery=0, invitations=0, emailVerifications=0, socialTransactions=1, socialSensitiveProofs=1, socialHandoffCodes=1, loginLinks=0, sessions=0'
    await kernel.exec('account-kit:prune', ['--dry-run'])
    assert.include(messages, `Expired: ${suffix}`)
    for (const table of [
      'social_transactions',
      'social_sensitive_proofs',
      'social_handoff_codes',
    ]) {
      assert.lengthOf(await kit.db.from(table), 1)
    }

    await kernel.exec('account-kit:prune', [])
    assert.include(messages, `Pruned: ${suffix}`)
    for (const table of [
      'social_transactions',
      'social_sensitive_proofs',
      'social_handoff_codes',
    ]) {
      assert.lengthOf(await kit.db.from(table), 0)
    }
    assert.lengthOf(await kit.db.from('social_identities'), 1)
  })

  test('dry run, bounded deletion, and repeated runs count only expired rows', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const other = await insertUser(kit, { email: 'other@example.test' })
    const expired = DateTime.utc().minus({ days: 1 }).toISO()
    const live = DateTime.utc().plus({ days: 1 }).toISO()
    for (const [index, expiresAt] of [expired, live].entries()) {
      await kit.db.table('password_reset_tokens').insert({
        tokenable_id: index === 0 ? user.id : other.id,
        email: index === 0 ? user.email : 'other@example.test',
        hash: `recovery-${index}`,
        expires_at: expiresAt,
        created_at: expired,
      })
      await kit.db.table('account_invitations').insert({
        email: `invite-${index}@example.test`,
        role: 'member',
        inviter_id: user.id,
        token_hash: `invitation-${index}`,
        expires_at: expiresAt,
        created_at: expired,
        updated_at: expired,
      })
      await kit.db.table('email_verification_tokens').insert({
        tokenable_id: index === 0 ? user.id : other.id,
        email: `next-${index}@example.test`,
        hash: `email-${index}`,
        expires_at: expiresAt,
        created_at: expired,
      })
      await kit.db.table('login_link_tokens').insert({
        tokenable_id: index === 0 ? user.id : other.id,
        email: index === 0 ? user.email : 'other@example.test',
        hash: `login-${index}`,
        client_challenge: 'c'.repeat(43),
        expires_at: expiresAt,
        created_at: expired,
      })
    }
    const expected = {
      recovery: 1,
      invitations: 1,
      emailVerifications: 1,
      socialTransactions: 0,
      socialSensitiveProofs: 0,
      socialHandoffCodes: 0,
      loginLinks: 1,
      sessions: 0,
    }
    assert.deepEqual(await pruneExpired(kit.db, { batchSize: 1, dryRun: true }), expected)
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 2)
    assert.deepEqual(await pruneExpired(kit.db, { batchSize: 1 }), expected)
    assert.deepEqual(await pruneExpired(kit.db, { batchSize: 1 }), {
      recovery: 0,
      invitations: 0,
      emailVerifications: 0,
      socialTransactions: 0,
      socialSensitiveProofs: 0,
      socialHandoffCodes: 0,
      loginLinks: 0,
      sessions: 0,
    })
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
    assert.lengthOf(await kit.db.from('login_link_tokens'), 1)
  })

  test('rechecks expiry after selection so a refreshed invitation survives', async ({ assert }) => {
    const user = await insertUser(kit)
    const expired = DateTime.utc().minus({ days: 1 }).toISO()
    const live = DateTime.utc().plus({ days: 1 }).toISO()
    const [id] = await kit.db
      .table('account_invitations')
      .insert({
        email: 'refreshed@example.test',
        role: 'member',
        inviter_id: user.id,
        token_hash: 'old-hash',
        expires_at: expired,
        created_at: expired,
        updated_at: expired,
      })
      .returning('id')
    const invitationId = typeof id === 'object' ? id.id : id
    let refreshed = false
    const db = new Proxy(kit.db, {
      get(target, property) {
        if (property === 'rawQuery') {
          return (sql: string, bindings: unknown[]) => {
            const query = target.rawQuery(sql, bindings)
            return {
              exec: async () => {
                if (sql.startsWith('delete from account_invitations')) {
                  await target.from('account_invitations').where('id', invitationId).update({
                    token_hash: 'new-hash',
                    expires_at: live,
                    updated_at: live,
                  })
                  refreshed = true
                }
                return query.exec()
              },
            }
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Database
    const result = await pruneExpired(db, { batchSize: 1 })
    assert.isTrue(refreshed)
    assert.equal(result.invitations, 0)
    const row = await kit.db.from('account_invitations').where('id', invitationId).first()
    assert.equal(row.token_hash, 'new-hash')
  })

  test('limits the total work of a run and allows a later run to finish', async ({ assert }) => {
    const user = await insertUser(kit)
    const expired = DateTime.utc().minus({ days: 1 }).toISO()
    await kit.db.table('account_invitations').insert({
      email: 'pending@example.test',
      role: 'member',
      inviter_id: user.id,
      token_hash: 'pending-hash',
      expires_at: expired,
      created_at: expired,
      updated_at: expired,
    })
    await kit.db.table('email_verification_tokens').insert({
      tokenable_id: user.id,
      email: 'next@example.test',
      hash: 'next-hash',
      expires_at: expired,
      created_at: expired,
    })
    assert.deepEqual(await pruneExpired(kit.db, { batchSize: 1, maxBatches: 1 }), {
      recovery: 0,
      invitations: 1,
      emailVerifications: 0,
      socialTransactions: 0,
      socialSensitiveProofs: 0,
      socialHandoffCodes: 0,
      loginLinks: 0,
      sessions: 0,
    })
    assert.deepEqual(await pruneExpired(kit.db, { batchSize: 1, maxBatches: 1 }), {
      recovery: 0,
      invitations: 0,
      emailVerifications: 1,
      socialTransactions: 0,
      socialSensitiveProofs: 0,
      socialHandoffCodes: 0,
      loginLinks: 0,
      sessions: 0,
    })
  })

  test('rejects invalid batch sizes before querying', async ({ assert }) => {
    for (const batchSize of [0, -1, 1.5, 1001, Number.NaN])
      await assert.rejects(() => pruneExpired(kit.db, { batchSize }), RangeError)
    for (const maxBatches of [0, -1, 1.5, 1001, Number.NaN])
      await assert.rejects(() => pruneExpired(kit.db, { maxBatches }), RangeError)
  })
})
