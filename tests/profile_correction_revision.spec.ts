import { test } from '@japa/runner'
import { CorrectionRevisions } from '../src/profile_correction_revision.ts'

test.group('profile correction revision', () => {
  test('is read once, so an object returned again later carries none', ({ assert }) => {
    // A caching adapter can hand back the same account object on a later profile update.
    const revisions = new CorrectionRevisions()
    const account = { id: 1 }
    revisions.remember(account, '2026-11-06T00:00:00.000Z')
    assert.equal(revisions.take(account), '2026-11-06T00:00:00.000Z')
    assert.isUndefined(revisions.take(account))
    assert.isUndefined(revisions.take(undefined))
  })
})
