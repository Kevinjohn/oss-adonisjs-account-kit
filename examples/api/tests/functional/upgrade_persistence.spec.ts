import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'

const email = 'upgrade-marker@example.test'
const customMigration = '1791906000000_create_role_assignments'
const phase = process.env.ACCOUNT_KIT_UPGRADE_PHASE

if (phase) {
  test('preserves existing account data and application migration records across upgrade', async ({
    assert,
  }) => {
    assert.include(['baseline', 'candidate'], phase)

    if (phase === 'baseline') {
      await User.query().where('email', email).delete()
      const user = await User.create({
        fullName: 'Existing User',
        email,
        password: 'ExistingPass123!',
      })
      await db.table('role_assignments').insert({ user_id: user.id, role: 'owner' })
      assert.isNotNull(await db.from('adonis_schema').where('name', customMigration).first())
      return
    }

    const user = await User.findBy('email', email)
    assert.isNotNull(user)
    const role = await db.from('role_assignments').where('user_id', user!.id).first()
    assert.equal(role?.role, 'owner')
    assert.isNotNull(await db.from('adonis_schema').where('name', customMigration).first())
  })
}
