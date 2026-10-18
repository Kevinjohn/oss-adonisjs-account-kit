import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { dbTime } from './helpers/db_time.js'
import { insertUser } from './helpers/fakes.js'

test.group('social provider subjects', (group) => {
  const kit = useTestApp(group)

  test('subjects that differ only by case, accent or trailing space stay distinct', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const subjects = ['subject', 'SUBJECT', 'subjéct', 'subject ']
    for (const subject of subjects)
      await kit.db.table('social_identities').insert({
        user_id: user.id,
        provider: 'github',
        provider_user_id: subject,
        email: null,
        email_verified: false,
        created_at: dbTime(kit),
        updated_at: dbTime(kit),
      })
    for (const subject of subjects) {
      const rows = await kit.db
        .from('social_identities')
        .where('provider', 'github')
        .where('provider_user_id', subject)
      assert.deepEqual(
        rows.map((row) => row.provider_user_id),
        [subject]
      )
    }
  })
})
