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

The callbacks, recipient and operation timing:

| Callback                     | Arguments                                   | Send to                              | Called after                                                                                                   |
| ---------------------------- | ------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `passwordResetProvision`     | `user, url`                                 | `user.email`                         | The reset token is committed.                                                                                  |
| `accountActivationProvision` | `user, url`                                 | `user.unverifiedEmail ?? user.email` | An activation token is committed for registration, verification resend, or an inactive account's email change. |
| `invitationProvision`        | `invitation, url`                           | `invitation.email`                   | An invitation is created or resent.                                                                            |
| `emailChangeProvision`       | `user, newEmail, url`                       | `newEmail`                           | An email-change token is committed for a confirmed account.                                                    |
| `emailChanged`               | `previousEmail, user`                       | `previousEmail`                      | The confirmed email change commits.                                                                            |
| `passwordResetCompleted`     | `user, context`                             | `user.email`                         | The password reset commits. `context.operation` is `password_reset`.                                           |
| `passwordChanged`            | `user, context`                             | `user.email`                         | The password change commits. `context.operation` is `password_change`.                                         |
| `socialIdentityLinked`       | `user, identity` (`SocialIdentity`)         | `user.email`                         | The provider identity is linked; sent only when the account has a confirmed email.                             |
| `socialIdentityUnlinked`     | `user, identity` (`SocialIdentity`)         | `user.email`                         | The provider identity is unlinked; sent only when the account has a confirmed email.                           |
| `magicLinkProvision`         | `user, url`                                 | `user.email`                         | The client-bound, one-use sign-in token is committed.                                                          |
| `accountDeleted`             | `account` (`DeletedAccount`: `id`, `email`) | `account.email`                      | Account deletion commits; the user row is already gone, so use the supplied historical address.                |

All callbacks run after the account transaction commits. `context` is a `CredentialChangeContext`
with `operation`, `operationId` and `userId`. The magic-link proof is bound to the requesting
client, is single-use and expires. These callbacks do not place a durable delivery intent in the
account transaction. If delivery must survive process or transport failure, persist the intent in
an application-owned transaction and process it with an application worker; see
[Notifications](../notifications.md).

## Render without sending

`renderAccountMessage(kind, { brandName, actionUrl })` returns `{ subject, text, html }`. Use it to
preview templates or to send through a provider SDK instead of AdonisJS Mail. Pass
`emailLayout` third and `{ i18n }` fourth for the same layout and language as
`createMailNotifications`.

## Emails in another language

The built-in emails use one site-wide language, chosen by you. Pass an
[`@adonisjs/i18n`](https://docs.adonisjs.com/guides/digging-deeper/i18n) instance for that locale.
Like `mail`, pass a function: it is called when each message is sent, after the i18n service
exists.

```ts
import i18nManager from '@adonisjs/i18n/services/main'

notify: createMailNotifications({
  from: 'Acme <accounts@acme.test>',
  brandName: 'Acme',
  i18n: () => i18nManager.locale('fr'),
}),
```

Each part of an email is looked up as `account_kit.emails.<kind>.<part>`, and the copy-link line as
`account_kit.emails.copy_link`. Messages use ICU placeholders: `{brandName}`, `{provider}` and
`{url}`. Each `subject` is the complete subject, so a translation can move or drop the brand. A
missing key falls back to the English text, and `@adonisjs/i18n` emits its
`i18n:missing:translation` event. Translated text is escaped like the English text. Without an
`emailLayout`, `<html lang>` is the instance's locale. There is no per-recipient language.

Copy this file to `resources/lang/<locale>/account_kit.json` and translate the values:

```json
{
  "emails": {
    "passwordResetProvision": {
      "subject": "{brandName}: Reset your password",
      "heading": "Reset your password",
      "body": "Use the link below to set a new password. If you did not request this, you can ignore this message.",
      "action": "Reset password"
    },
    "accountActivationProvision": {
      "subject": "{brandName}: Confirm your email address",
      "heading": "Confirm your email address",
      "body": "Use the link below to confirm your email address.",
      "action": "Confirm email address"
    },
    "invitationProvision": {
      "subject": "{brandName}: You are invited",
      "heading": "You are invited",
      "body": "Use the link below to accept your invitation.",
      "action": "Accept invitation"
    },
    "emailChangeProvision": {
      "subject": "{brandName}: Confirm your new email address",
      "heading": "Confirm your new email address",
      "body": "Use the link below to confirm this email address.",
      "action": "Confirm new email address"
    },
    "emailChanged": {
      "subject": "{brandName}: Your email address changed",
      "heading": "Your email address changed",
      "body": "The email address on your account was changed. If this was unexpected, contact support immediately."
    },
    "passwordResetCompleted": {
      "subject": "{brandName}: Your password was reset",
      "heading": "Your password was reset",
      "body": "The password on your account was reset. If this was unexpected, contact support immediately."
    },
    "passwordChanged": {
      "subject": "{brandName}: Your password changed",
      "heading": "Your password changed",
      "body": "The password on your account was changed. If this was unexpected, contact support immediately."
    },
    "socialIdentityLinked": {
      "subject": "{brandName}: A social sign-in method was linked",
      "heading": "A social sign-in method was linked",
      "body": "{provider} sign-in was linked to your account. If this was unexpected, contact support immediately."
    },
    "socialIdentityUnlinked": {
      "subject": "{brandName}: A social sign-in method was removed",
      "heading": "A social sign-in method was removed",
      "body": "{provider} sign-in was removed from your account. If this was unexpected, contact support immediately."
    },
    "magicLinkProvision": {
      "subject": "{brandName}: Your sign-in link",
      "heading": "Sign in",
      "body": "Use the link below to sign in. Open it in the browser or app where you asked for it. It works once and expires soon. If you did not ask to sign in, you can ignore this message.",
      "action": "Sign in"
    },
    "accountDeleted": {
      "subject": "{brandName}: Your account was deleted",
      "heading": "Your account was deleted",
      "body": "Your account and its sign-in details were deleted. If this was unexpected, contact support immediately."
    },
    "copy_link": "Or copy this link: {url}"
  }
}
```

## Further reading

- [Notifications](../notifications.md): delivery failures, readiness checks and durable delivery.
- [Development mail](development-mail.md): print messages instead of sending them.
