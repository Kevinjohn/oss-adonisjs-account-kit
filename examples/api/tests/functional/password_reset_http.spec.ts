/* eslint-disable @unicorn/no-await-expression-member -- Keep recovery request results adjacent to baseline assertions. */

import { test } from '@japa/runner'
import hash from '@adonisjs/core/services/hash'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { truncateDatabase } from '#tests/helpers/database'

test.group('Password reset HTTP', (group) => {
  group.each.setup(truncateDatabase)

  test('stage-3 recovery baseline persists through real HTTP requests', async ({
    client,
    assert,
  }) => {
    notifications.reset()
    const user = await User.create({
      fullName: 'Upgrade Baseline',
      email: 'upgrade-baseline@example.test',
      password: 'OriginalPass123!',
    })

    const requested = await client.post('/api/v1/auth/password-reset').json({ email: user.email })
    assert.equal(requested.status(), 202)
    assert.deepEqual(requested.body(), {
      message: 'If the account exists, instructions will be sent.',
    })
    const token = tokenFrom(notifications.events.find((event) => event.kind === 'recovery')!.value)
    const path = `/api/v1/auth/password-reset/${encodeURIComponent(token)}`
    assert.equal((await client.get(path)).status(), 200)
    const reset = await client.post(path).json({
      password: 'BaselineReset123!',
      passwordConfirmation: 'BaselineReset123!',
    })
    assert.equal(reset.status(), 202)
    await user.refresh()
    assert.isTrue(await hash.verify(user.password!, 'BaselineReset123!'))
    assert.isNull(user.unverifiedEmail)
    assert.equal(
      (
        await client
          .post(path)
          .json({ password: 'ReplayReset123!', passwordConfirmation: 'ReplayReset123!' })
      ).status(),
      400
    )
  })
})
