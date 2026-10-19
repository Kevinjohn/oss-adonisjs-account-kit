# Account notifications

## Configuration

Install and configure `@adonisjs/mail` version 10 in the application, including its real transport and a
verified sender address. Import Mail only in the application configuration; service-only imports
of Account Kit do not load it.

```ts
import { createActionUrls, createMailNotifications, defineConfig } from 'adonisjs-account-kit'

const urls = createActionUrls({
  backendOrigin: 'https://api.example.com/v1/',
  appFrontendUrl: 'https://app.example.com/account/',
  destinations: {
    passwordReset: 'reset',
    emailVerification: 'confirm',
    invitation: 'invitation',
    emailChange: 'confirm-email-change',
    // magicLink: 'sign-in/link', when magicLinkLogin is enabled
  },
  environment: 'production',
})

const notify = createMailNotifications({
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

The code sample's `users` and `limiterSecret` are application values, not package exports.
`createMailNotifications` uses the AdonisJS Mail service, resolved when each message is sent.
Config files load before AdonisJS services exist, so do not pass the imported `mail` service
object; to use a different mailer, pass `mail: () => myMailer`. A
custom callback object remains supported in place of `createMailNotifications`; individual
callbacks can be overridden by spreading the maintained set first. The mail integration owns
message content and transport calls, while the application owns the sender identity and Mail
transport. `emailLayout` wraps escaped package content; treat that callback as trusted
application code. `brandName`, `from`, and `emailLayout` do not affect token issuance.
The exported `*Provision` classes hold action-link values for the maintained callbacks; they
are not AdonisJS `BaseMail` subclasses. Pass callbacks returned by `createMailNotifications`
to Account Kit rather than passing those values directly to `mail.sendLater`.

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
The generated URLs contain bearer proofs. Redact their path and query at the browser frontend,
reverse proxy, application access logger, analytics, and error-reporting boundaries; never log
the full link. Set proof landing pages and responses to `Cache-Control: no-store` and a strict
`Referrer-Policy: no-referrer`, and avoid third-party resources on those pages. Carry the proof
only to the intended backend operation. These controls apply to both configured frontend paths
and any manual development path.

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
links, plus password-reset, password-change, email-change, social-link and social-unlink security notices. Each message has
an HTML heading, descriptive link text, and a plain-text version containing the full URL.
Dynamic text and URLs are HTML escaped. `createMailNotifications` calls AdonisJS Mail's
`sendLater`, after the account operation has committed. It does not install a queue or outbox.
Social notices name Google or GitHub and go only to the account address confirmed at the time
of the relationship change. Pending provider associations and unconfirmed addresses do not
trigger them. Configure the maintained callbacks directly through `notify` when enabling
`socialAuthentication`; no separate social transport is needed.

`sendLater` acceptance means the configured Mail delivery mechanism accepted the message; it
does not prove recipient delivery. With `best-effort`, Account Kit does not retry a failed or
lost message. Record failures privately with an operation ID and message kind, omitting proofs,
full URLs, passwords, and unnecessary personal data. Action-link callback rejection is reported
as `DeliveryError`; credential notice or other post-commit follow-up failure is reported as
`PostCommitError` with `committed: true`. Both can follow a committed account change, so never
blindly repeat a non-repeatable mutation. A transport failure _after_ `sendLater` accepts the
message is observable through the application's Mail transport or worker logs, not a later
Account Kit exception. Password-reset request HTTP handlers must suppress delivery status and
return the same acknowledgement for known and unknown addresses.
With Mail's default in-memory messenger, a later transport failure emits the
`queued:mail:error` event. Subscribe in the application and record a private, redacted failure
with an operation correlation ID where available; queue acceptance alone cannot prove recipient
delivery. The Mail event itself does not carry the Account Kit operation ID.
Mail's normal `mail:queueing` and `mail:queued` events also include rendered message bodies
and bearer-proof URLs. Never log entire Mail lifecycle event payloads; allowlist only safe
diagnostic fields such as message kind, transport outcome, and an application correlation ID.

For durable delivery, the application must persist a notification intent in the same transaction
as the account change and send it from an application-owned worker after commit. Here is the
shape of an application-owned credential notice intent:

```ts
onCredentialsChangedTransaction: async (user, context, trx) => {
  if (context.operation !== 'password_reset' && context.operation !== 'password_change') return
  await trx.table('application_notification_outbox').insert({
    operation_id: context.operationId,
    kind: context.operation,
    user_id: user.id,
    recipient_email: user.email,
    state: 'pending',
  })
},
```

Use a unique key on `(operation_id, kind)` and have the worker send to the captured event-time
`recipient_email`; do not re-resolve it from a later account state. Protect this personal data
at rest and remove it under the application's retention policy. Claim records safely across
workers, retry transient failures with
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

## Files and migrations

In the consuming application, install and configure AdonisJS Mail in `config/mail.ts`, register
its provider and command in `adonisrc.ts`, and add sender, public-origin and transport references
to `start/env.ts` and the environment file. Set `notify`, `urls` and `delivery` in
`config/account_kit.ts`; existing custom callback implementations may stay. The application
must supply browser landing pages for enabled proof flows. A durable choice additionally needs
an application migration for its outbox or queue state, a worker, retry and failure monitoring,
and operational configuration. Account Kit does not generate those application files.

## Before deployment

Configure the application Mail transport, sender, public origins and browser destinations. Send
a development test message and inspect both HTML and text. Follow each link to the application
page and exercise its backend operation. Test a transport failure and check that the committed
account state is intact, the error is recorded privately, and the public password-reset
acknowledgement remains generic. For production, verify the actual delivery mode and any
application-owned worker operations before marking readiness complete.
