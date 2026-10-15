import { test } from '@japa/runner'
import {
  createActionUrls,
  createMailNotifications,
  notificationReadiness,
  renderAccountMessage,
} from '../src/notifications.js'
import { DeliveryError } from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeNotify, makeService } from './helpers/fakes.js'

const user = {
  id: 1,
  email: 'person@example.test',
  unverifiedEmail: null,
  hasPassword: true,
  emailVerifiedAt: null,
}

test.group('maintained notifications', () => {
  test('renders equivalent safe HTML and text for every action and security notice', ({
    assert,
  }) => {
    const kinds = [
      'passwordResetProvision',
      'accountActivationProvision',
      'invitationProvision',
      'emailChangeProvision',
      'emailChanged',
      'passwordResetCompleted',
      'passwordChanged',
    ] as const
    for (const kind of kinds) {
      const rendered = renderAccountMessage(kind, {
        brandName: '<Company & Co>',
        actionUrl: 'https://example.test/action?a=1&b="<bad>"',
        recipient: 'person@example.test',
      })
      assert.include(rendered.text, '<Company & Co>')
      assert.notInclude(rendered.html, '<Company & Co>')
      assert.notInclude(rendered.html, '<bad>')
      assert.include(rendered.html, '&lt;Company &amp; Co&gt;')
      assert.include(rendered.html, '<main>')
      assert.include(rendered.html, '<h1>')
      if (kind.endsWith('Provision')) {
        assert.include(rendered.text, 'https://example.test/action?a=1&b="<bad>"')
        assert.include(
          rendered.html,
          'href="https://example.test/action?a=1&amp;b=&quot;&lt;bad&gt;&quot;"'
        )
      }
    }
  })

  test('queues through Mail sendLater with configured sender and layout, including security notices', async ({
    assert,
  }) => {
    const messages: Record<string, unknown>[] = []
    const mail = {
      sendLater: async (callback: (message: any) => void) => {
        const fields: Record<string, unknown> = {}
        const message = Object.fromEntries(
          ['to', 'from', 'subject', 'html', 'text'].map((key) => [
            key,
            (value: string) => {
              fields[key] = value
              return message
            },
          ])
        )
        callback(message)
        messages.push(fields)
      },
    }
    const notify = createMailNotifications({
      mail,
      from: 'Accounts <accounts@example.test>',
      brandName: 'Example',
      emailLayout: (body) => `<div class="custom">${body}</div>`,
    })
    await notify.passwordResetProvision(user, 'https://example.test/reset')
    await notify.accountActivationProvision(user, 'https://example.test/verify')
    await notify.invitationProvision(
      {
        id: 2,
        email: user.email,
        role: 'reader',
        inviterId: null,
        expiresAt: null as never,
        createdAt: null as never,
        updatedAt: null as never,
      },
      'https://example.test/invite'
    )
    await notify.emailChangeProvision(user, 'new@example.test', 'https://example.test/change')
    await notify.emailChanged('old@example.test', user)
    await notify.passwordResetCompleted(user, {
      operation: 'password_reset',
      operationId: '1',
      userId: 1,
    })
    await notify.passwordChanged(user, {
      operation: 'password_change',
      operationId: '2',
      userId: 1,
    })
    assert.lengthOf(messages, 7)
    assert.equal(messages[0].from, 'Accounts <accounts@example.test>')
    assert.equal(messages[3].to, 'new@example.test')
    assert.equal(messages[4].to, 'old@example.test')
    assert.include(messages[0].html as string, 'class="custom"')
    assert.include(messages[0].text as string, 'https://example.test/reset')
  })

  test('rejects sender and brand header breaks before queuing', ({ assert }) => {
    const mail = { sendLater: async () => assert.fail('mail should not be called') }
    assert.throws(
      () =>
        createMailNotifications({
          mail,
          from: 'accounts@example.test\r\nBcc: other@example.test',
          brandName: 'Example',
        }),
      /from and brandName/
    )
    assert.throws(
      () =>
        createMailNotifications({
          mail,
          from: 'accounts@example.test',
          brandName: 'Example\nBcc: other@example.test',
        }),
      /from and brandName/
    )
  })

  test('rejects untrusted and insecure action origins while preserving base paths', ({
    assert,
  }) => {
    const urls = createActionUrls({
      backendOrigin: 'https://api.example.test/v1/',
      appFrontendUrl: 'https://app.example.test/account/',
      destinations: {
        passwordReset: 'reset',
        emailVerification: 'verify',
        invitation: 'invite',
        emailChange: 'change',
      },
      environment: 'production',
    })
    assert.equal(urls.passwordReset('a/b'), 'https://app.example.test/account/reset/a%2Fb')
    assert.throws(
      () =>
        createActionUrls({
          backendOrigin: 'http://localhost:3333',
          appFrontendUrl: 'https://app.example.test',
          destinations: { passwordReset: 'reset' },
          environment: 'production',
        }),
      /HTTPS/
    )
    assert.throws(
      () =>
        createActionUrls({
          backendOrigin: 'https://api.example.test',
          appFrontendUrl: 'https://user:pass@app.example.test',
          destinations: { passwordReset: 'reset' },
          environment: 'production',
        }),
      /origin/
    )
    assert.throws(
      () =>
        createActionUrls({
          backendOrigin: 'https://api.example.test',
          appFrontendUrl: 'https://app.example.test',
          destinations: { passwordReset: 'https://evil.example/path' },
          environment: 'production',
        }),
      /destination/
    )
  })

  test('readiness distinguishes durable declarations, best effort and unsafe production setup', ({
    assert,
  }) => {
    const bestEffort = notificationReadiness({
      environment: 'production',
      delivery: 'best-effort',
      transport: 'delivery',
      backendOrigin: 'https://api.example.test',
      actionOrigin: 'https://app.example.test',
      enabled: ['passwordReset'],
      destinations: { passwordReset: 'reset' },
    })
    assert.equal(bestEffort.classification, 'best effort')
    assert.isTrue(bestEffort.ready)
    assert.include(bestEffort.notes.join(' '), 'retry')
    const unsafe = notificationReadiness({
      environment: 'production',
      delivery: 'durable',
      transport: 'delivery',
      backendOrigin: 'http://localhost:3333',
      actionOrigin: 'https://app.example.test',
      enabled: ['passwordReset'],
      destinations: {},
    })
    assert.isFalse(unsafe.ready)
    assert.include(unsafe.problems.join(' '), 'HTTPS')
    assert.include(unsafe.problems.join(' '), 'worker')
    const durable = notificationReadiness({
      environment: 'production',
      delivery: 'durable',
      transport: 'delivery',
      backendOrigin: 'https://api.example.test',
      actionOrigin: 'https://app.example.test',
      enabled: ['passwordReset'],
      destinations: { passwordReset: 'reset' },
      durableChecks: {
        worker: true,
        retries: true,
        terminalFailures: true,
        actionLinks: true,
        securityNotices: true,
      },
    })
    assert.isTrue(durable.ready)
    assert.equal(durable.classification, 'application declared durable')
    const capture = notificationReadiness({
      environment: 'production',
      delivery: 'capture',
      transport: 'capture',
      backendOrigin: 'https://api.example.test',
      actionOrigin: 'https://app.example.test',
      enabled: ['passwordReset'],
      destinations: { passwordReset: 'reset' },
    })
    assert.isFalse(capture.ready)
    assert.include(capture.problems.join(' '), 'transport')
  })
})

test.group('maintained mail operation', (group) => {
  const kit = useTestApp(group)

  test('Mail is queued after commit and its failure preserves the proof', async ({ assert }) => {
    await insertUser(kit)
    const calls: string[] = []
    const mail = {
      sendLater: async (_callback: (message: any) => void) => {
        const rows = await kit.db.from('password_reset_tokens')
        assert.lengthOf(rows, 1)
        calls.push('queued-after-commit')
        throw new Error('transport failed')
      },
    }
    const notify = {
      ...makeNotify().notify,
      ...createMailNotifications({ mail, from: 'accounts@example.test', brandName: 'Example' }),
    }
    const { account } = makeService(kit, { minRequestMs: 0, notify })
    try {
      await account.passwordReset.request({ email: 'person@example.test', clientKey: 'first' })
      assert.fail('expected delivery failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal(((error as DeliveryError).cause as Error).message, 'transport failed')
    }
    assert.deepEqual(calls, ['queued-after-commit'])
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
    assert.isUndefined(
      await account.passwordReset.request({ email: 'absent@example.test', clientKey: 'second' })
    )
    assert.deepEqual(calls, ['queued-after-commit'])
  })
})
