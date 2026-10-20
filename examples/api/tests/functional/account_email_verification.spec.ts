/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { test } from '@japa/runner'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { truncateDatabase } from '#tests/helpers/database'

test.group('Account email verification', (group) => {
  group.each.setup(truncateDatabase)

  test('email verification over HTTP requires authentication and consumes its token once', async ({
    client,
    assert,
  }) => {
    notifications.reset()

    const verificationUser = await User.create({
      fullName: 'Verify User',
      email: 'verify@example.test',
      unverifiedEmail: 'verify@example.test',
      password: 'VerifyPass123!',
    })
    const anonymousVerify = await client.post('/api/v1/account/email-verification/send').json({})
    assert.equal(anonymousVerify.status(), 401, JSON.stringify(anonymousVerify.body()))
    const sendVerification = await client
      .post('/api/v1/account/email-verification/send')
      .loginAs(verificationUser)
      .json({})
    assert.equal(sendVerification.status(), 200)
    assert.equal(sendVerification.body().result, 'sent')
    const verificationToken = tokenFrom(
      notifications.events.find((event) => event.kind === 'verification')!.value
    )
    const verificationPath = `/api/v1/auth/email-verification/${encodeURIComponent(verificationToken)}`
    const verificationFirst = await client.get(verificationPath)
    assert.equal(verificationFirst.header('referrer-policy'), 'no-referrer')
    assert.equal(verificationFirst.header('cache-control'), 'no-store')
    assert.deepEqual(verificationFirst.body(), { confirmation: true })
    const verificationComplete = await client
      .post(verificationPath)
      .json({ password: 'ClaimedVerify123!', passwordConfirmation: 'ClaimedVerify123!' })
    assert.equal((verificationComplete.body() as { result: string }).result, 'verified')
    assert.equal(
      (
        await client
          .post(verificationPath)
          .json({ password: 'ClaimedVerify123!', passwordConfirmation: 'ClaimedVerify123!' })
      ).status(),
      400
    )
    assert.equal(
      (
        (
          await client
            .post('/api/v1/account/email-verification/send')
            .loginAs(verificationUser)
            .json({})
        ).body() as { result: string }
      ).result,
      'already_verified'
    )
  })
})
