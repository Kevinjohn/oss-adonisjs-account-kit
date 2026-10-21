# Send account mail through AdonisJS Mail

Replace the generated throwing notification callbacks or a local `createLogNotifications` capture
with the AdonisJS Mail service already configured by your application. Account Kit supplies the
message templates and calls `sendLater`; the application selects the sender, transport, queue,
worker and failure policy.

## Starting point and files

Use an AdonisJS 7 app on Node 24 with Account Kit configured and a local password-reset flow.
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

See the [example acceptance record](../guides/example-acceptance.md) for the tested starter versions, exact disposable changes, commands, results and limits.
