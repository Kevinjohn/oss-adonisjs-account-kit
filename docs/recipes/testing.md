# Testing your account flows

`adonisjs-account-kit/testing/notifications` records notifications in memory, so tests can follow
a reset or verification link without a mail fake.

## Capture notifications

Use the capture's `notify` in your test config. One way is to read it from a module your config
imports:

```ts
// tests/helpers/account_mail.ts
import { captureNotifications } from 'adonisjs-account-kit/testing/notifications'

export const accountMail = captureNotifications()
```

```ts
// config/account_kit.ts
import app from '@adonisjs/core/services/app'

notify: app.inTest
  ? (await import('#tests/helpers/account_mail')).accountMail.notify
  : createMailNotifications({ from: 'accounts@acme.test', brandName: 'Acme' }),
```

## Follow a link in a test

```ts
import { test } from '@japa/runner'
import { accountMail } from '#tests/helpers/account_mail'

test.group('password reset', (group) => {
  group.each.setup(() => accountMail.clear())

  test('resets a password from the emailed link', async ({ client }) => {
    await client.post('/account-kit/recovery').json({ email: 'someone@example.com' })

    const token = accountMail.tokenFor('passwordResetProvision', 'someone@example.com')
    const response = await client
      .post(`/account-kit/recovery/${token}`)
      .json({ password: 'a-new-long-password' })

    response.assertStatus(200)
  })
})
```

The capture API:

| Member                | Returns                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `notify`              | The callbacks to pass as Account Kit's `notify` config.                                                   |
| `messages`            | Every captured message: `{ kind, to, actionUrl?, token?, args }`.                                         |
| `last(kind, to?)`     | The newest message of that kind, optionally to one address.                                               |
| `tokenFor(kind, to?)` | The token from that message's link (its `token` query value, else its last path segment). Throws if none. |
| `clear()`             | Empties `messages`.                                                                                       |

## Rate limits in tests

Many requests from one client hit the default budget of five recovery requests per 15 minutes.
Raise it in tests only:

```ts
...(app.inTest ? { throttle: { requests: 100, duration: '15m' } } : {}),
```

Also set `minRequestMs: 0` in tests to skip the timing floor on password reset requests.

## Testing a custom users adapter

See [custom adapter](custom-adapter.md) for the adapter contract suite.
