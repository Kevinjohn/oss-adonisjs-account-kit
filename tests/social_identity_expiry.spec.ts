import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { clientChallenge } from './helpers/social_identity.js'

test.group('social expiry cleanup', (group) => {
  const kit = useTestApp(group)
  test('prunes expired transaction, recent-proof, and handoff rows in bounded batches', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const past = '2020-01-01T00:00:00.000Z'
    await kit.db.table('social_transactions').insert({
      hash: 'a'.repeat(64),
      provider: 'google',
      intent: 'login',
      client_challenge: clientChallenge,
      expires_at: past,
      created_at: past,
    })
    await kit.db.table('social_sensitive_proofs').insert({
      hash: 'b'.repeat(64),
      user_id: user.id,
      purpose: 'social_link',
      expires_at: past,
      created_at: past,
    })
    await kit.db.table('social_identities').insert({
      user_id: user.id,
      provider: 'google',
      provider_user_id: 'expired-handoff-subject',
      email_verified: false,
      created_at: past,
      updated_at: past,
    })
    const relation = await kit.db.from('social_identities').first()
    await kit.db.table('social_handoff_codes').insert({
      hash: 'c'.repeat(64),
      user_id: user.id,
      social_identity_id: relation.id,
      client_challenge: clientChallenge,
      expires_at: past,
      created_at: past,
    })
    const { account } = makeService(kit)
    const counts = await account.maintenance.prune({ batchSize: 1 })
    assert.equal(counts.socialTransactions, 1)
    assert.equal(counts.socialSensitiveProofs, 1)
    assert.equal(counts.socialHandoffCodes, 1)
    assert.lengthOf(await kit.db.from('social_transactions'), 0)
    assert.lengthOf(await kit.db.from('social_sensitive_proofs'), 0)
    assert.lengthOf(await kit.db.from('social_handoff_codes'), 0)
  })
})
