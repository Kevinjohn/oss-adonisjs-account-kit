import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'

test.group('test application', (group) => {
  let testApp: Awaited<ReturnType<typeof bootTestApp>>

  group.setup(async () => {
    testApp = await bootTestApp()
  })

  group.each.setup(async () => {
    await resetSchema(testApp)
    await testApp.limiter.clear()
  })

  group.teardown(async () => {
    await testApp.close()
  })

  test('boots with a resettable database and transaction support', async ({ assert }) => {
    await testApp.db.table('users').insert({
      email: 'person@example.test',
      password: null,
      created_at: new Date().toISOString(),
    })

    const user = await testApp.db.from('users').where('email', 'person@example.test').first()
    assert.equal(user.email, 'person@example.test')
    assert.isNull(user.password)

    await testApp.db.transaction(async (trx) => {
      await trx.from('users').where('id', user.id).forUpdate().first()
    })
  })
})
