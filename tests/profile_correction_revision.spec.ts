import { test } from '@japa/runner'
import {
  correctionRevision,
  rememberCorrectionRevision,
} from '../src/profile_correction_revision.js'

test.group('profile correction revision', () => {
  test('is read once, so an object returned again later carries none', ({ assert }) => {
    // A caching adapter can hand back the same account object on a later profile update.
    const account = { id: 1 }
    rememberCorrectionRevision(account, '2026-11-06T00:00:00.000Z')
    assert.equal(correctionRevision(account), '2026-11-06T00:00:00.000Z')
    assert.isUndefined(correctionRevision(account))
    assert.isUndefined(correctionRevision(undefined))
  })
})
