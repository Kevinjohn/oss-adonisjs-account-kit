import { test } from '@japa/runner'
import {
  createActionUrls,
  notificationReadiness,
  renderAccountMessage,
} from '../src/notifications.js'

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
      'magicLinkProvision',
      'accountDeleted',
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
      magicLinkProvision: [
        'Sign in',
        'Open it in the browser or app where you asked for it.',
        'Sign in',
      ],
      accountDeleted: [
        'Your account was deleted',
        'Your account and its sign-in details were deleted.',
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
    const magic = notificationReadiness({
      environment: 'production',
      delivery: 'best-effort',
      transport: 'delivery',
      backendOrigin: 'https://api.example.test',
      actionOrigin: 'https://app.example.test',
      enabled: ['magicLinkLogin'],
      destinations: {},
    })
    assert.isFalse(magic.ready)
    assert.include(magic.problems.join(' '), 'magicLink destination')
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

  test('maintained action emails keep brand, instructions, and link in reading order', ({
    assert,
  }) => {
    const actions = [
      ['passwordResetProvision', 'Reset password'],
      ['accountActivationProvision', 'Confirm email address'],
      ['invitationProvision', 'Accept invitation'],
      ['emailChangeProvision', 'Confirm new email address'],
    ] as const

    for (const [kind, label] of actions) {
      const rendered = renderAccountMessage(kind, {
        brandName: 'Account Team',
        actionUrl: 'https://example.test/action',
      })
      const htmlOrder = [
        rendered.html.indexOf('>Account Team</p>'),
        rendered.html.indexOf('<h1>'),
        rendered.html.indexOf('<p>Use the link below'),
        rendered.html.indexOf('<a href='),
        rendered.html.indexOf(`>${label}</a>`),
        rendered.html.indexOf('Or copy this link:'),
      ]
      const textOrder = [
        rendered.text.indexOf('Account Team'),
        rendered.text.indexOf('\n\n', rendered.text.indexOf('Account Team')),
        rendered.text.indexOf('Use the link below'),
        rendered.text.indexOf(label),
        rendered.text.indexOf('https://example.test/action'),
      ]

      assert.isTrue(htmlOrder.every((index) => index >= 0))
      assert.isTrue(
        htmlOrder.every((index, position) => position === 0 || htmlOrder[position - 1]! < index)
      )
      assert.isTrue(textOrder.every((index) => index >= 0))
      assert.isTrue(
        textOrder.every((index, position) => position === 0 || textOrder[position - 1]! < index)
      )
    }
  })
})
