# Send account mail through AdonisJS Mail

Replace the generated throwing notification callbacks or a local `createLogNotifications` capture
with the AdonisJS Mail service already configured by your application. Account Kit supplies the
message templates and calls `sendLater`; the application selects the sender, transport, queue,
worker and failure policy.

## Log messages during local development

Before Mail is configured, print account emails, links included, to the application log instead
of sending them:

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

`createLogNotifications` replaces the generated throwing callbacks and renders the message and
proof URL into the local log; it does not configure AdonisJS Mail, contact a recipient, or prove
delivery. Set a fixed development `APP_URL` and point `urls.passwordReset` at the local page or
route that will consume the proof. These values come from application configuration, not the
request's `Host` header. It throws when `environment` is `'production'`, because logged links are
live credentials; keep development logs private.

## Starting point and files

Use an AdonisJS 7 app on Node 24 with Account Kit configured and a local password-reset flow.
Keep its existing Auth guard, route middleware and, for browser stacks, CSRF middleware unchanged.
Add `@adonisjs/mail` 10 with the SMTP transport if the app does not already have it:

```sh
node ace add @adonisjs/mail --transports=smtp
```

The command installs the package and creates `config/mail.ts`, registers its provider, and adds
its environment settings. For this recipe, use a loopback SMTP capture service such as Mailpit;
keep sender and recipient addresses fictional.

Configure `config/mail.ts` and its `start/env.ts` settings to point to the local SMTP catcher,
for example `SMTP_HOST=127.0.0.1` and the catcher's local SMTP port. Do not put real credentials
in a committed environment file. The AdonisJS
[Mail guide](https://docs.adonisjs.com/guides/digging-deeper/mail) has the version-10 transport,
message and fake-mail APIs.

In `config/account_kit.ts`, replace the local logger callback with the maintained Mail callbacks:

```ts
import { createMailNotifications } from 'adonisjs-account-kit'

notify: createMailNotifications({
  from: 'Example Accounts <accounts@example.test>',
  brandName: 'Example',
}),
```

Do not import the Mail service object into this config: it loads before AdonisJS services. The
maintained callback resolves the service when a notification is sent. Keep your application-owned
`urls` pointing at its local proof page and backend; action links contain bearer proofs and must
not be written to shared logs or analytics.

Files normally touched are `config/account_kit.ts`, `config/mail.ts`, `start/env.ts` and the
untracked local `.env`. If Mail is not installed, its command also registers its provider and
environment settings. Existing API routes and account policy stay application-owned.

## Check configured dispatch safely

Start the local SMTP catcher and the app with `pnpm dev`. Request a reset for a test account, inspect
the captured message in the catcher, follow its link to the app-owned page, and complete the reset
against the selected local database. Also request reset for an unknown address and confirm the
public response is the same generic `202`; it should produce no message. A local SMTP catcher
proves the app rendered and dispatched a message through the configured transport path. It does not
prove that an external provider accepted it or that a recipient received it.

`createMailNotifications` awaits AdonisJS Mail's `sendLater` after the Account Kit transaction
commits. That call queues the message; it does not wait for SMTP acceptance or recipient delivery.
AdonisJS Mail 10's default messenger is an in-memory queue: it dispatches in the web process, needs
no separate worker, and loses pending messages if the process stops before sending. A later SMTP
error is emitted by Mail as `queued:mail:error`; it is not automatically converted to an Account Kit
`DeliveryError` for the already-returned HTTP request. Subscribe to that event and monitor transport
outcomes. For production, use a persistent messenger such as the documented AdonisJS Queue
integration, deploy its worker with the web app, and configure retries and terminal-failure
handling. Queue acceptance is still not recipient delivery. See
[Account notifications](../notifications.md) for Account Kit callback failure boundaries and
production readiness requirements.

If Account Kit's awaited notification callback or queue submission rejects, it reports a committed
delivery or follow-up failure. A later in-memory SMTP failure uses Mail's `queued:mail:error` event;
Account Kit does not automatically retry that asynchronous send. Log only a redacted operation
name, message kind and safe correlation ID; never record the proof URL or full mail event. A
password-reset request still returns its generic acknowledgement, so the person can request a fresh
link. For a committed password change, reset, signup or other mutation, inspect the saved account
state and use that flow's recovery path; do not repeat signup because its post-commit notification
failed. For signup, sign in or request a fresh verification link if delivery did not arrive. The
[operations guide](../operations.md#recover-from-committed-notification-or-observer-failures)
describes each recovery decision.

The API example's [notification callbacks](../../examples/api/app/services/account_kit_notifications.ts)
are a deterministic fixture, not an AdonisJS Mail transport or production worker. Its captured
message verifies callback content and proof handling only. For real local dispatch, follow this
recipe with the configured SMTP catcher; for recipient delivery, verify the application's actual
provider and worker outside the local fixture. The application's existing i18n policy owns
user-facing language; Account Kit does not select a locale.

## Disposable acceptance

The disposable API app used the repository's `examples/api` reference app at source revision
`ae42132` and was prepared with `pnpm test:consumer -- --database=sqlite --prepare-only`. It ran
Node `v24.21.0`, AdonisJS Core `7.6.0`, Auth `10.1.0`, Lucid `22.4.2`, Vine `4.4.0`, Account Kit
`0.0.0`, and SQLite. The app added AdonisJS Mail `10.4.0` with:

```sh
pnpm add @adonisjs/mail@10.4.0
node ace add @adonisjs/mail --transports=smtp
```

It changed
`config/account_kit.ts` to `createMailNotifications`, and pointed `config/mail.ts` and `.env` at a
loopback-only SMTP capture service on `127.0.0.1:1025`. With `pnpm dev`, a known reset request
returned generic `202` and produced a captured message; an unknown address returned the same `202`
and produced no message. The captured proof was inspected and completed against SQLite. This proves
local rendering and configured SMTP dispatch, not provider acceptance or recipient delivery.
The exercised HTTP operations were `POST /api/v1/auth/password-reset` for a known and an unknown
fictional address, `GET /api/v1/auth/password-reset/:token`, and `POST` to that proof path with the
new password and confirmation.

A second disposable run set SMTP to `127.0.0.1:1027` with no listener and added a temporary
`queued:mail:error` event logger in `start/routes.ts`. `pnpm dev` served a fictional signup with
`POST /api/v1/auth/signup` and HTTP `200`; Mail later emitted the event for `mailerName: 'smtp'`,
and `POST /api/v1/auth/login` for the same fictional account returned `200`. The account therefore
remained usable after the asynchronous transport failure. This did not test a worker retry or prove
recipient delivery; the app needs an explicit retry policy for later queue errors. The temporary
event logger and captured tests were not committed as repository test files.

See the [example acceptance record](../guides/example-acceptance.md) for the starter/package
versions and shared acceptance boundaries.
