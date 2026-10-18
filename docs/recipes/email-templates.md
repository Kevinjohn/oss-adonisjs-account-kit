# Custom email templates

Account Kit ships plain, escaped templates for every account email. You can wrap them in your own
layout, or replace them completely.

## Send the built-in emails with AdonisJS Mail

```ts
// config/account_kit.ts
import { createMailNotifications } from 'adonisjs-account-kit'

notify: createMailNotifications({
  from: 'Acme <accounts@acme.test>',
  brandName: 'Acme',
}),
```

Messages go through the AdonisJS Mail service's `sendLater`, so they use your configured mail
queue. The service is looked up when each message is sent; do not pass the imported `mail` object
here, because config files load before it exists.

## Wrap them in your layout

`emailLayout` receives the escaped body markup and returns the full HTML document:

```ts
notify: createMailNotifications({
  from: 'Acme <accounts@acme.test>',
  brandName: 'Acme',
  emailLayout: (body) => `<!doctype html>
<html lang="en">
  <body style="font-family: system-ui, sans-serif; background: #f6f6f6; padding: 24px">
    <div style="max-width: 560px; margin: auto; background: #fff; padding: 32px">${body}</div>
  </body>
</html>`,
}),
```

The body is already escaped; do not escape it again, and do not insert untrusted values into the
layout.

## Replace a message

`notify` is a plain object of callbacks, so you can override any of them. This sends the reset
link with an Edge template and keeps the built-in messages for everything else:

```ts
import mail from '@adonisjs/mail/services/main'
import { createMailNotifications } from 'adonisjs-account-kit'

const builtIn = createMailNotifications({ from: 'accounts@acme.test', brandName: 'Acme' })

notify: {
  ...builtIn,
  passwordResetProvision: async (user, url) => {
    await mail.sendLater((message) => {
      message
        .to(user.email)
        .from('accounts@acme.test')
        .subject('Reset your Acme password')
        .htmlView('emails/password_reset', { url })
    })
  },
},
```

Reading `mail` inside the callback is safe: by the time a message is sent, the service exists.

The callbacks and what each receives:

| Callback                     | Arguments             | Send to                              |
| ---------------------------- | --------------------- | ------------------------------------ |
| `passwordResetProvision`     | `user, url`           | `user.email`                         |
| `accountActivationProvision` | `user, url`           | `user.unverifiedEmail ?? user.email` |
| `invitationProvision`        | `invitation, url`     | `invitation.email`                   |
| `emailChangeProvision`       | `user, newEmail, url` | `newEmail`                           |
| `emailChanged`               | `previousEmail, user` | `previousEmail`                      |
| `passwordResetCompleted`     | `user, context`       | `user.email`                         |
| `passwordChanged`            | `user, context`       | `user.email`                         |
| `socialIdentityLinked`       | `user, identity`      | `user.email`                         |
| `socialIdentityUnlinked`     | `user, identity`      | `user.email`                         |

## Render without sending

`renderAccountMessage(kind, { brandName, actionUrl })` returns `{ subject, text, html }`. Use it to
preview templates or to send through a provider SDK instead of AdonisJS Mail.

## Further reading

- [Notifications](../notifications.md): delivery failures, readiness checks and durable delivery.
- [Development mail](development-mail.md): print messages instead of sending them.
