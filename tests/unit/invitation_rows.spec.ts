import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { toInvitation } from '../../src/invitation_rows.js'

test.group('database row mapping', () => {
  test('maps an invitation and omits its private token hash', async ({ assert }) => {
    const expiration = new Date('2026-05-06T07:08:09.000Z')
    const createdAt = new Date('2026-05-01T00:00:00.000Z')
    const updatedAt = new Date('2026-05-02T00:00:00.000Z')
    const invitation = toInvitation({
      id: 3,
      email: 'person@example.test',
      role: 'editor',
      inviter_id: 12,
      token_hash: 'private-hash',
      expires_at: expiration,
      created_at: createdAt,
      updated_at: updatedAt,
    })
    assert.deepEqual(invitation, {
      id: 3,
      email: 'person@example.test',
      role: 'editor',
      inviterId: 12,
      expiresAt: DateTime.fromJSDate(expiration, { zone: 'utc' }),
      createdAt: DateTime.fromJSDate(createdAt, { zone: 'utc' }),
      updatedAt: DateTime.fromJSDate(updatedAt, { zone: 'utc' }),
    })
    assert.notProperty(invitation, 'token_hash')
  })
})
