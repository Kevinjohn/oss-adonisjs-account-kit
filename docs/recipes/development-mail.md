# Development mail

Print account emails, links included, to the application log instead of sending them:

```ts
// config/account_kit.ts
import app from '@adonisjs/core/services/app'
import { createLogNotifications, createMailNotifications } from 'adonisjs-account-kit'

notify: app.inProduction
  ? createMailNotifications({ from: 'accounts@acme.test', brandName: 'Acme' })
  : createLogNotifications({ brandName: 'Acme', environment: app.inTest ? 'test' : 'development' }),
```

Messages go to the AdonisJS logger. To send them elsewhere, pass `logger`: either an object with
an `info(message)` method, or a function returning one. Use a function for AdonisJS services,
because config files load before services exist.

The generated `notify` callbacks throw until this block is replaced. `createLogNotifications`
replaces those callbacks and renders the message and proof URL into the local log; it does not
configure AdonisJS Mail, contact a recipient, or prove delivery. Set a fixed development `APP_URL`
and point `urls.passwordReset` at the local page or route that will consume the proof. These values
come from application configuration, not the request's `Host` header. Treat every logged proof URL
as a live bearer credential and keep development logs private.

`createLogNotifications` renders the same text as the built-in templates and logs it:

```
[account-kit] mail to someone@example.com: Acme: Reset your password
Acme

Reset your password

Use the link below to set a new password. If you did not request this, you can ignore this message.

Reset password: http://localhost:3333/account-kit/recovery/2fGx...
```

It throws when `environment` is `'production'`, because logged links are live credentials.

For production, replace the capture callback with `createMailNotifications` after configuring the
application's real AdonisJS Mail transport and verified sender. See [Account notifications](../notifications.md)
for transport ownership, delivery checks and production requirements.

## Other options

- Keep AdonisJS Mail and use a local SMTP catcher such as Mailpit to see real HTML.
- Call `notificationReadiness(...)` at boot to warn when a capture or discard transport would reach
  production. See [notifications](../notifications.md).
