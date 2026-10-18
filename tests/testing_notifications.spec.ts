import { test } from '@japa/runner'
import { captureNotifications } from '../testing/notifications.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'

test.group('captureNotifications', (group) => {
  const kit = useTestApp(group)

  test('captures a reset link whose token completes the reset', async ({ assert }) => {
    const user = await insertUser(kit)
    const mail = captureNotifications()
    const { account } = makeService(kit, { minRequestMs: 0, notify: mail.notify })
    await account.passwordReset.request({ email: user.email, clientKey: 'capture' })

    const sent = mail.last('passwordResetProvision', user.email)
    assert.isDefined(sent)
    assert.equal(sent!.actionUrl, `https://example.test/recovery/${sent!.token}`)
    await account.passwordReset.reset({
      token: mail.tokenFor('passwordResetProvision', user.email),
      password: 'new-password123',
    })
    assert.deepEqual(
      mail.messages.map((message) => [message.kind, message.to]),
      [
        ['passwordResetProvision', user.email],
        ['passwordResetCompleted', user.email],
      ]
    )
    assert.isUndefined(mail.messages[1].token)
  })

  test('reads a token query value and reports a missing token', async ({ assert }) => {
    const mail = captureNotifications()
    await mail.notify.invitationProvision(
      { email: 'guest@example.test' } as never,
      'https://example.test/accept?token=abc%2Fdef'
    )
    assert.equal(mail.tokenFor('invitationProvision'), 'abc/def')
    assert.throws(
      () => mail.tokenFor('invitationProvision', 'other@example.test'),
      'No invitationProvision notification with a token to other@example.test'
    )
    mail.clear()
    assert.lengthOf(mail.messages, 0)
    assert.throws(() => mail.tokenFor('invitationProvision'), /No invitationProvision/)
  })
})
