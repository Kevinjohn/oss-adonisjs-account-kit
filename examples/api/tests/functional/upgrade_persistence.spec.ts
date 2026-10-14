import { test } from '@japa/runner'
import hash from '@adonisjs/core/services/hash'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'

const email = 'upgrade-marker@example.test'
const customMigration = 'database/migrations/1791906000000_create_role_assignments'
const phase = process.env.ACCOUNT_KIT_UPGRADE_PHASE

if (phase) {
  test('preserves working account behavior, data, and application migrations across upgrade', async ({
    assert,
    client,
  }) => {
    assert.include(['baseline', 'candidate'], phase)

    if (phase === 'baseline') {
      notifications.reset()
      await db.from('role_assignments').where('role', 'owner').delete()
      await User.query().where('email', email).delete()
      const user = await User.create({
        fullName: 'Existing User',
        email,
        password: 'ExistingPass123!',
      })
      await db.table('role_assignments').insert({ user_id: user.id, role: 'owner' })
      assert.isNotNull(await db.from('adonis_schema').where('name', customMigration).first())

      const requested = await client.post('/account-kit/recovery').json({ email })
      assert.equal(requested.status(), 202)
      const notice = notifications.events.find((event) => event.kind === 'recovery')
      assert.isNotNull(notice)
      if (!notice) throw new Error('The baseline adapter did not deliver a recovery notice')
      const token = decodeURIComponent(new URL(notice.value).pathname.split('/').at(-1)!)
      const path = `/account-kit/recovery/${encodeURIComponent(token)}`
      const inspected = await client.get(path)
      assert.equal(inspected.status(), 200)
      const reset = await client.post(path).json({
        password: 'BaselineReset123!',
        passwordConfirmation: 'BaselineReset123!',
      })
      assert.equal(reset.status(), 202)
      await user.refresh()
      assert.equal(user.fullName, 'Existing User')
      assert.equal(user.email, email)
      assert.isTrue(await hash.verify(user.password, 'BaselineReset123!'))
      return
    }

    const user = await User.findBy('email', email)
    assert.isNotNull(user)
    assert.equal(user!.fullName, 'Existing User')
    assert.isTrue(await hash.verify(user!.password, 'BaselineReset123!'))
    const role = await db.from('role_assignments').where('user_id', user!.id).first()
    assert.equal(role?.role, 'owner')
    assert.isNotNull(await db.from('adonis_schema').where('name', customMigration).first())
  })
}
