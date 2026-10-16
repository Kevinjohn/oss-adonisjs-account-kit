import { test } from '@japa/runner'
import { MailManager } from '@adonisjs/mail'
import { JSONTransport } from '@adonisjs/mail/transports/json'
import {
  createActionUrls,
  createMailNotifications,
  notificationReadiness,
  renderAccountMessage,
  type AccountMailService,
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
      'socialIdentityLinked',
      'socialIdentityUnlinked',
    ] as const
    const expected = {
      passwordResetProvision: [
        'Reset your password',
        'Use the link below to set a new password.',
        'Reset password',
      ],
      accountActivationProvision: [
        'Confirm your email address',
        'Use the link below to confirm your email address.',
        'Confirm email address',
      ],
      invitationProvision: [
        'You are invited',
        'Use the link below to accept your invitation.',
        'Accept invitation',
      ],
      emailChangeProvision: [
        'Confirm your new email address',
        'Use the link below to confirm this email address.',
        'Confirm new email address',
      ],
      emailChanged: [
        'Your email address changed',
        'The email address on your account was changed.',
        null,
      ],
      passwordResetCompleted: [
        'Your password was reset',
        'The password on your account was reset.',
        null,
      ],
      passwordChanged: ['Your password changed', 'The password on your account was changed.', null],
      socialIdentityLinked: [
        'A social sign-in method was linked',
        'Google sign-in was linked to your account.',
        null,
      ],
      socialIdentityUnlinked: [
        'A social sign-in method was removed',
        'Google sign-in was removed from your account.',
        null,
      ],
    } as const
    for (const kind of kinds) {
      const rendered = renderAccountMessage(kind, {
        brandName: '<Company & Co>',
        actionUrl: 'https://example.test/action?a=1&b="<bad>"',
        providerName: 'Google',
      })
      assert.include(rendered.text, '<Company & Co>')
      assert.notInclude(rendered.html, '<Company & Co>')
      assert.notInclude(rendered.html, '<bad>')
      assert.include(rendered.html, '&lt;Company &amp; Co&gt;')
      assert.include(rendered.html, '<main>')
      assert.include(rendered.html, '<h1>')
      const [heading, body, action] = expected[kind]
      assert.include(rendered.text, heading)
      assert.include(rendered.html, `<h1>${heading}</h1>`)
      assert.include(rendered.text, body)
      assert.include(rendered.html, body)
      if (kind.endsWith('Provision')) {
        assert.include(rendered.text, action!)
        assert.include(rendered.html, `>${action}</a>`)
        assert.include(rendered.text, 'https://example.test/action?a=1&b="<bad>"')
        assert.include(
          rendered.html,
          'href="https://example.test/action?a=1&amp;b=&quot;&lt;bad&gt;&quot;"'
        )
      } else {
        assert.notInclude(rendered.text, 'https://example.test/action')
        assert.notInclude(rendered.html, 'https://example.test/action')
        assert.notInclude(rendered.html, '<a ')
      }
    }
  })

  test('escapes provider text in social notices and requires a provider name', ({ assert }) => {
    assert.throws(
      () => renderAccountMessage('socialIdentityLinked', { brandName: 'Example' }),
      'requires a provider name'
    )
    const rendered = renderAccountMessage('socialIdentityLinked', {
      brandName: 'Example',
      providerName: '<unsafe & provider>',
    })
    assert.include(rendered.text, '<unsafe & provider> sign-in')
    assert.include(rendered.html, '&lt;unsafe &amp; provider&gt; sign-in')
    assert.notInclude(rendered.html, '<unsafe')
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
    const identity = {
      id: 4,
      userId: user.id,
      provider: 'google' as const,
      providerUserId: 'google-subject',
      email: user.email,
      emailVerified: true,
    }
    await notify.socialIdentityLinked(user, identity)
    await notify.socialIdentityUnlinked(user, identity)
    assert.lengthOf(messages, 9)
    assert.equal(messages[0].from, 'Accounts <accounts@example.test>')
    assert.equal(messages[3].to, 'new@example.test')
    assert.equal(messages[4].to, 'old@example.test')
    assert.include(messages[0].html as string, 'class="custom"')
    assert.include(messages[0].text as string, 'https://example.test/reset')
    assert.equal(messages[7].to, user.email)
    assert.include(messages[7].text as string, 'Google sign-in was linked')
    assert.include(messages[8].html as string, 'Google sign-in was removed')
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
    for (const destination of [
      ' https://evil.example/reset',
      ' //evil.example/reset',
      '%2e%2e/reset',
      '%2E%2e/reset',
      'safe/%2e%2e/%2E%2E/reset',
    ]) {
      assert.throws(
        () =>
          createActionUrls({
            backendOrigin: 'https://api.example.test',
            appFrontendUrl: 'https://app.example.test/account/',
            destinations: { passwordReset: destination },
            environment: 'production',
          }),
        /destination/
      )
    }
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
    assert.include(unsafe.problems.join(' '), 'passwordReset destination')
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
    const discard = notificationReadiness({
      environment: 'production',
      delivery: 'best-effort',
      transport: 'discard',
      backendOrigin: 'https://api.example.test',
      actionOrigin: 'https://app.example.test',
      enabled: ['passwordReset'],
      destinations: { passwordReset: 'reset' },
    })
    assert.isFalse(discard.ready)
    assert.include(discard.problems.join(' '), 'transport')
    const contradictory = notificationReadiness({
      environment: 'development',
      delivery: 'durable',
      transport: 'capture',
      backendOrigin: 'http://localhost:3333',
      actionOrigin: 'http://localhost:5173',
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
    assert.isFalse(contradictory.ready)
    assert.include(contradictory.problems.join(' '), 'capture')
    const developmentCapture = notificationReadiness({
      environment: 'development',
      delivery: 'capture',
      transport: 'capture',
      backendOrigin: 'http://localhost:3333',
      actionOrigin: 'http://localhost:5173',
      enabled: ['passwordReset'],
      destinations: { passwordReset: 'reset' },
    })
    assert.isTrue(developmentCapture.ready)
    assert.equal(developmentCapture.classification, 'development capture')
    assert.include(developmentCapture.notes.join(' '), 'no message was delivered')
  })
})

test.group('maintained mail operation', (group) => {
  const kit = useTestApp(group)

  test('real Mail JSON transport receives the queued envelope and both rendered variants', async ({
    assert,
  }) => {
    const messages: Parameters<JSONTransport['send']>[0][] = []
    class CapturingJSONTransport extends JSONTransport {
      async send(message: Parameters<JSONTransport['send']>[0]) {
        messages.push(message)
        return super.send(message)
      }
    }
    const manager = new MailManager({ emit: async () => {} } as never, {
      default: 'json',
      mailers: { json: () => new CapturingJSONTransport() },
    })
    const mail: AccountMailService = manager
    const notify = createMailNotifications({
      mail,
      from: 'Accounts <accounts@example.test>',
      brandName: 'Example',
    })
    try {
      await notify.passwordResetProvision(user, 'https://app.example.test/reset/example-proof')
      const identity = {
        id: 5,
        userId: user.id,
        provider: 'github' as const,
        providerUserId: 'github-subject',
        email: user.email,
        emailVerified: true,
      }
      await notify.socialIdentityLinked(user, identity)
      await notify.socialIdentityUnlinked(user, identity)
      for (let attempt = 0; attempt < 100 && messages.length < 3; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.lengthOf(messages, 3)
      assert.deepEqual(messages[0].to, ['person@example.test'])
      assert.equal(messages[0].from, 'Accounts <accounts@example.test>')
      assert.include(messages[0].html as string, 'Reset password')
      assert.include(messages[0].text as string, 'https://app.example.test/reset/example-proof')
      assert.deepEqual(messages[1].to, ['person@example.test'])
      assert.include(messages[1].text as string, 'GitHub sign-in was linked')
      assert.include(messages[2].html as string, 'GitHub sign-in was removed')
    } finally {
      await manager.closeAll()
    }
  })

  test('real Mail reports a transport failure after queue acceptance without undoing the proof', async ({
    assert,
  }) => {
    await insertUser(kit)
    const events: string[] = []
    const failures: unknown[] = []
    class FailingJSONTransport extends JSONTransport {
      async send(_message: Parameters<JSONTransport['send']>[0]): Promise<never> {
        throw new Error('simulated transport failure')
      }
    }
    const manager = new MailManager(
      {
        emit: async (event: string, payload: unknown) => {
          events.push(event)
          if (event === 'queued:mail:error') failures.push(payload)
        },
      } as never,
      { default: 'json', mailers: { json: () => new FailingJSONTransport() } }
    )
    const mail: AccountMailService = manager
    const notify = createMailNotifications({
      mail,
      from: 'accounts@example.test',
      brandName: 'Example',
    })
    const { account } = makeService(kit, { minRequestMs: 0, notify })
    try {
      assert.isUndefined(
        await account.passwordReset.request({ email: 'person@example.test', clientKey: 'first' })
      )
      for (let attempt = 0; attempt < 100 && !events.includes('queued:mail:error'); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.include(events, 'mail:queued')
      assert.include(events, 'queued:mail:error')
      assert.lengthOf(failures, 1)
      assert.equal((failures[0] as { error: Error }).error.message, 'simulated transport failure')
      assert.notInclude(JSON.stringify(failures[0]), 'https://')
      assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
    } finally {
      await manager.closeAll()
    }
  })

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

  test('social notice queue failure follows committed link and unlink operations', async ({
    assert,
  }) => {
    const local = await insertUser(kit, { email: 'social-mail@example.test' })
    const states: string[] = []
    const mail = {
      sendLater: async (_callback: (message: any) => void) => {
        const rows = await kit.db.from('social_identities').where('user_id', local.id)
        states.push(String(rows.length))
        throw new Error('notice queue failed')
      },
    }
    const notify = createMailNotifications({
      mail,
      from: 'accounts@example.test',
      brandName: 'Example',
    })
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: {
        providers: {
          google: {
            authorizationUrl: async (state: string) => `https://provider.test/start?state=${state}`,
            resolve: async () => ({
              subject: 'mail-subject',
              email: local.email,
              emailVerified: true,
            }),
          },
        },
      },
      authentication: { strategy: 'session', guard: 'web' },
      notify,
    })
    const current = { userId: local.id, revision: null }
    const clientChallenge = 'a'.repeat(43)
    const begin = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      current,
      clientChallenge,
    })
    const linkProof = await account.socialAuthentication.provePassword({
      current,
      password: 'password123',
      purpose: 'social_link',
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: begin.state,
          callback: {},
          current,
          proof: linkProof,
        }),
      DeliveryError
    )
    const relations = await account.socialAuthentication.list({ current })
    const relation = relations[0]
    assert.isDefined(relation)
    const unlinkProof = await account.socialAuthentication.provePassword({
      current,
      password: 'password123',
      purpose: 'social_unlink',
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.unlink({
          current,
          identityId: relation.id,
          proof: unlinkProof,
        }),
      DeliveryError
    )
    assert.deepEqual(states, ['1', '0'])
    assert.lengthOf(await kit.db.from('social_identities').where('user_id', local.id), 0)
  })
})
