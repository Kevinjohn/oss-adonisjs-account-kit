# Account notifications

## Configuration

Install and configure `@adonisjs/mail` in the application, including its real transport and a
verified sender address. Import Mail only in the application configuration; service-only imports
of Account Kit do not load it.

```ts
import mail from '@adonisjs/mail/services/main'
import { createActionUrls, createMailNotifications, defineConfig } from 'adonisjs-account-kit'

const urls = createActionUrls({
  backendOrigin: 'https://api.example.com/v1/',
  appFrontendUrl: 'https://app.example.com/account/',
  destinations: {
    passwordReset: 'reset',
    emailVerification: 'confirm',
    invitation: 'invitation',
    emailChange: 'confirm-email-change',
  },
  environment: 'production',
})

const notify = createMailNotifications({
  mail,
  from: 'Accounts <accounts@example.com>',
  brandName: 'Example',
  // emailLayout: (body) => `<div class="mail-shell">${body}</div>`,
})

export default defineConfig({
  // ...users, limiterSecret, authorization and other application policy...
  users,
  limiterSecret,
  urls,
  notify,
  delivery: 'best-effort',
})
```

The code sample's `users` and `limiterSecret` are application values, not package exports. A
custom callback object remains supported in place of `createMailNotifications`; individual
callbacks can be overridden by spreading the maintained set first. The mail integration owns
message content and transport calls, while the application owns the sender identity and Mail
transport. `emailLayout` wraps escaped package content; treat that callback as trusted
application code. `brandName`, `from`, and `emailLayout` do not affect token issuance.

An email contains a browser link. The application supplies that browser landing page and its
password-entry or confirmation form. The page calls the relevant backend operation; the mail
link itself does not complete a reset or confirmation. An API-only development install may copy
proofs from an explicitly configured local capture transport and call the backend operation
manually. Production readiness requires real destinations for all enabled action flows.

`backendOrigin` is the public backend URL; `appFrontendUrl` is the public browser URL. Both may
contain a base path, which is preserved. Destinations are relative paths below
`appFrontendUrl`. Request `Host` and forwarded headers never supply these values. Public
production origins must be HTTPS; HTTP is accepted only for loopback development. Configure
trusted proxies by their known addresses and verify secure cookies under TLS termination in the
consuming application. Forwarded headers alone do not prove a request is secure.

Call `notificationReadiness` with the selected environment, delivery mode, origins, enabled
capabilities, destination paths, and the application's selected `transport` behavior (`delivery`,
`capture`, or `discard`). It reports missing destinations, insecure origins, and
capture in production. `delivery: 'durable'` is an application declaration: verify its worker,
retry and terminal-failure handling for both action links and security notices, then pass
`durableChecks: { worker: true, retries: true, terminalFailures: true, actionLinks: true,
securityNotices: true }` when producing the readiness report. Without such a
system, choose `best-effort`; this is allowed in production and the report says so.

## How it works

The maintained templates cover password reset, account activation, invitation and email-change
links, plus password-reset, password-change and email-change security notices. Each message has
an HTML heading, descriptive link text, and a plain-text version containing the full URL.
Dynamic text and URLs are HTML escaped. `createMailNotifications` calls AdonisJS Mail's
`sendLater`, after the account operation has committed. It does not install a queue or outbox.

`sendLater` acceptance means the configured Mail delivery mechanism accepted the message; it
does not prove recipient delivery. With `best-effort`, Account Kit does not retry a failed or
lost message. Use the application's Mail/transport logs to investigate. A callback rejection is
reported as `DeliveryError`; the account change may already have committed, so never blindly
repeat a non-repeatable mutation. Password-reset request HTTP handlers must suppress delivery
status and return the same acknowledgement for known and unknown addresses.

For durable delivery, the application must persist a notification intent in the same transaction
as the account change and send it from an application-owned worker after commit. Here is the
shape of an application-owned credential notice intent:

```ts
onCredentialsChangedTransaction: async (user, context, trx) => {
  await trx.table('application_notification_outbox').insert({
    operation_id: context.operationId,
    kind: context.operation,
    user_id: user.id,
    state: 'pending',
  })
},
```

Use a unique key on `(operation_id, kind)` and let the worker resolve the recipient and render
the notice after commit. Claim records safely across workers, retry transient failures with
backoff, and retain terminal failures for alerting and manual repair. Keep the record until
delivery is acknowledged or the application's retention policy expires. External delivery can
occur twice if a worker crashes after sending but before acknowledging, so use receiver-side
deduplication where possible; do not claim exactly-once delivery. Link intents need their proof
and expiry captured in the same transaction, with encrypted or otherwise protected storage for
bearer tokens. The package's existing transaction hooks do not cover every link issuance, so
an application requiring durable links must integrate the relevant operation transaction
boundary; `delivery: 'durable'` alone cannot make links durable. A link expires according to
`expiresIn` even if queued; workers should stop retrying expired links. Security notices have
no action token and should retain enough non-secret context for later diagnosis. For a notice
to the previous address after an email change, capture that address transactionally before it
is replaced.

Development capture must be explicit in the application's Mail transport and should identify
captured messages as local artifacts. Do not use a silent discard transport in production or
present a captured message as delivered to its recipient.

## Files delta

`src/notifications.ts` provides the maintained renderer, Mail callback factory, trusted link
builder and readiness report. `src/types.ts` and `src/config.ts` add the `delivery` declaration,
defaulting to `best-effort`. `index.ts` exports the notification helpers. Existing custom
`notify` and `urls` callbacks remain valid.

## Manual steps

Configure the application Mail transport, sender, public origins and browser destinations. Send
a development test message and inspect both HTML and text. Follow each link to the application
page and exercise its backend operation. Test a transport failure and check that the committed
account state is intact, the error is recorded privately, and the public password-reset
acknowledgement remains generic. For production, verify the actual delivery mode and any
application-owned worker operations before marking readiness complete.

## Changelog

Unreleased: Added maintained account email templates, AdonisJS Mail `sendLater` callbacks,
trusted action links and explicit delivery readiness classification.
