# Security model

This page lists what Account Kit defends against, how, and what remains the application's job. It
describes the package defaults; each value can be changed in `config/account_kit.ts`. Each
defence names the source that implements it and the test that pins it, so you can check the claim
yourself.

## At a glance

| Threat                                   | Defence                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| A leaked database used to reset accounts | Links carry 40 random bytes; only a SHA-256 hash is stored.                         |
| Old or replayed links                    | Every link is single use and expires, checked inside the write transaction.         |
| Finding out who has an account           | Same response and a minimum duration for known and unknown addresses.               |
| Password guessing and mail flooding      | Per-client and per-address limits on every request that sends mail or checks one.   |
| Sessions surviving a password change     | Each credential change advances a revision; older sessions and tokens stop working. |
| Poisoned links in emails                 | Links are built from configured origins only, never from request headers.           |
| Races and half-finished changes          | One transaction per operation, with the user row locked.                            |
| Tokens leaking through the browser       | Proof pages send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.      |

## Proof tokens

Password reset, email verification, invitation, email change and magic-link URLs carry a proof
token.

- **Random and long.** 40 random bytes by default (`tokenSecretLength`, 16 to 64).
- **Stored as a hash.** The database holds the SHA-256 hash, never the token
  ([`tokens.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/src/tokens.ts)). A copy of the database cannot be turned into working links. Lookup is by
  hash, so application code never compares a secret against a stored value. Pinned by
  `password_reset.spec.ts`: "stores only a hash of the notified token and the normalized user
  email".
- **Single use.** Consuming a proof and making the change happen in one transaction, so two
  concurrent submissions succeed at most once. Pinned by "two independent reset transactions allow
  only one use".
- **Short-lived.** Password reset, email verification and email change expire after 1 hour, magic
  links after 15 minutes, invitations after 7 days (`expiresIn`). Pinned by "expired, reused, and
  malformed tokens cannot change the password".
- **One live link at a time.** A new reset or magic-link request replaces the previous link. Pinned by "replaces a
  previous request and concurrent requests leave one live row".
- **Not tied to `APP_KEY`.** Rotating the framework key does not invalidate outstanding links; see
  [operations](operations.md#secret-rotation).

Magic links add a client check: the browser or app that asked for the link keeps a PKCE-style
verifier, and the link only completes with it. A wrong verifier burns the link, because it may have
been forwarded. The verifier's challenge is compared with `timingSafeEqual` ([`magic_link.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/src/magic_link.ts)). Pinned
by `magic_link.spec.ts`: "a wrong verifier fails and burns the link; a malformed one consumes
nothing". See [magic-link sign-in](magic-link.md).

## Account enumeration

- **Password reset and magic-link requests** return the same result for known and unknown
  addresses. Every exit, including errors, waits out a minimum duration (`minRequestMs`, 300 ms).
  Pinned by "known and unknown requests both take at least the configured minimum" and "unknown
  addresses are silent and both paths wait out the floor".
- **Login** gives one error for absent accounts, wrong passwords, restricted accounts and accounts
  without a password, and waits out the same floor. Pinned by `authentication.spec.ts`: "rejects
  invalid credentials with one public error and counts failures only".
- **Managed signup** returns the same `email`/`unique` validation error for every existing account,
  whatever its state.
- **Signed-in devices:** an unknown id, a malformed id and another user's id all look the same.

Only known addresses get an email, so a failed send must not change the response. Your
reset-request controller must catch `DeliveryError` and `PostCommitError` and return the normal
response. Every controller in these docs does; see [getting started](getting-started.md).

## Rate limits

Limits use `@adonisjs/limiter`. A limited request throws `ThrottledError` (HTTP 429 with
`Retry-After`).

| Operation                          | Keys                                     | Default                              | Option                         |
| ---------------------------------- | ---------------------------------------- | ------------------------------------ | ------------------------------ |
| Password reset request             | client, normalized email                 | 5 per 15 minutes                     | `throttle`                     |
| Magic-link request                 | client, normalized email                 | 5 per 15 minutes                     | `throttle`                     |
| Verification resend                | user                                     | 5 per 15 minutes                     | `throttle`                     |
| Password, email and profile change | user                                     | 5 per 15 minutes                     | `throttle`                     |
| Account export and deletion        | user                                     | 5 per 15 minutes                     | `throttle`                     |
| Managed proof routes and signup    | client, per endpoint                     | 5 per 15 minutes                     | `throttle`                     |
| Invitation send                    | actor (10 per hour), recipient (3/hour)  | as listed                            | `invitationThrottle`           |
| Invitation resend                  | actor (10 per hour), invitation (3/hour) | as listed                            | `invitationThrottle`           |
| Login, per client                  | client, failures only                    | 10 per minute                        | `authentication.clientLimit`   |
| Login, per identity                | email, failures only                     | 5 per minute, then a 20-minute block | `authentication.identityLimit` |

Request limits are checked before the user lookup, so a throttled request reveals nothing. Pinned
by "the sixth client request is throttled before user lookup".

**Limiter keys hold no personal data.** Each key is an HMAC-SHA256 digest under a key derived from
`limiterSecret` with HKDF ([`throttle.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/src/throttle.ts)). The limiter store never holds an email address or
IP address. Pinned by `limiter_privacy.spec.ts`: "keys hide identifiers and separate secret,
namespace, and operation".

## Sessions and tokens

- **Credential revision.** Password reset, password change, email change, access restriction,
  social unlink and "sign out everywhere" advance the user's `credentials_changed_at` in the same
  transaction as the change.
- **Session guards** store the revision at sign-in and reject an older one on the next request.
  A session with no stored revision is rejected, not trusted. Pinned by "a session with a missing
  or old stamp never captures a fresh revision".
- **Token guards** delete the user's access tokens in the same transaction. Pinned by "token guard
  revokes all user tokens in the same transaction as a password change".
- **Races at sign-in.** A credential change that lands while a login is in flight cannot return a
  usable session or token. Pinned by "a credential change during provisional session establishment
  cannot return a usable session".
- **Session store.** Session login needs a server-side store (database or Redis). With the cookie
  store, a copied cookie would keep working after logout.

See [authentication](authentication.md) and [signed-in devices](signed-in-devices.md).

## Links in emails

- **Configured origins only.** Action URLs are built from configured origins and relative
  destinations. The request `Host` and forwarded headers are never used, so a forged header cannot
  redirect a link.
- **HTTPS in production.** A production origin must be HTTPS. Plain HTTP is accepted only for
  loopback development origins. Pinned by `notifications.spec.ts`: "rejects untrusted and insecure
  action origins while preserving base paths".
- **Safe email content.** Built-in templates escape every value, and action URLs must be absolute
  HTTP(S) URLs without credentials. Sender and brand values with line breaks are rejected before
  queuing.
- **Development mail refuses production.** `createLogNotifications` prints links to the log and
  throws if the environment is production.

## Browser and HTTP headers

- **Managed routes** send `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on every
  proof URL, including requests rejected early by the body parser or CSRF. Pinned by
  `managed_proof_headers.spec.ts`: "protects every selected proof URL even when later middleware
  rejects the request".
- **Your own proof pages** should send a `Referrer-Policy`. Use `same-origin` if the page posts
  back and relies on `redirect().back()`. The [Inertia recipe](recipes/inertia-react.md) shows it.
- **Proof URLs are bearer tokens.** Keep them out of access logs, analytics and error reporting.

## Transactions and races

- **One transaction per operation.** Each account operation runs in one package-owned transaction.
  PostgreSQL and MySQL lock the user row (`SELECT ... FOR UPDATE`); SQLite serializes package
  writes through a lock row ([`db.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/src/db.ts), [`transaction.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/src/transaction.ts)).
- **No half-finished changes.** If an adapter or hook fails, the token use, the password change and
  the revocation roll back together. Pinned by "adapter failure rolls back token consumption and
  password change".
- **After commit means committed.** Emails and lifecycle hooks run after commit. A `DeliveryError`
  or `PostCommitError` means the change happened and only a follow-up failed. Do not repeat the
  operation; see [errors](reference/errors.md).

## Optional features

- **Social sign-in.** Linking needs a verified provider email or a recent proof. One provider
  subject maps to one user. The handoff code is single use with PKCE. An account cannot remove its
  last sign-in method. See [social authentication](social-authentication.md).
- **Signed-in devices.** "Sign out everywhere" is a credential change. Every call first re-checks
  the caller in the same transaction, so a revoked session cannot manage others.
- **Account export and deletion.** Both need the current password or a single-use recent proof. The
  export never includes password hashes, token hashes or provider tokens. See
  [account export and deletion](account-data.md).
- **Password policy.** One policy applies to every new password: signup, reset, change, email
  verification and invitation acceptance. See [usage](usage.md).

## Supply chain

- Releases are published from GitHub Actions with npm provenance. Run `npm audit signatures` to
  check that an installed copy was built from this repository.
- CodeQL and OpenSSF Scorecard workflows scan the public repository.
- Dependabot takes patch updates for everything and minor updates only for AdonisJS-owned
  packages; majors move by hand with AdonisJS.
- The [dependency audit assessment](compatibility.md#dependency-audit-assessment) records known
  advisories and why each does not apply.

## What the application must do

- **Keep secrets stable and secret.** `APP_KEY` must be at least 32 bytes and identical on every
  instance that shares a limiter store. Rotating `limiterSecret` resets rate-limit budgets.
- **Configure trusted proxies before deriving `clientKey` from the request IP.** Never accept a
  client key supplied by the caller or an unverified `X-Forwarded-For` value.
- **Keep the reset response generic.** Catch `DeliveryError` and `PostCommitError` from
  `passwordReset.request` and return the normal response.
- **Redact proof URLs.** Links carry bearer tokens in their path. Keep them out of access logs,
  analytics, error reporting and logged `mail:queueing` payloads. Links printed by
  `account-kit:invite --print` and `account-kit:reset-link --print` are equally sensitive; keep
  them out of shell history files and shared terminals.
- **Authorize at the HTTP boundary.** Invitation authorization callbacks are the package's only
  business authorization. Route protection, roles and tenancy belong to the application.
- **Validate request shape and confirmations.** Account Kit enforces its password policy on new
  passwords, but validators own field shapes, password confirmation and terms acceptance.
- **Route account changes through Account Kit.** Direct database writes to users, tokens or
  sessions skip credential revocation.
- **Run `account-kit:prune` on a schedule.** Expired rows are not deleted automatically.
- **Deliver mail reliably if you need it.** The default delivery is best effort with no retry. Use
  a queue or outbox and set `delivery: 'durable'` when a lost message is unacceptable.

## Out of scope

- Two-factor authentication and passkeys. [AdonisJS Plus](https://plus.adonisjs.com) covers them.
- Browser session-store cleanup beyond the credential revision, API token policy beyond the
  configured hook, and team or tenant membership changes.
- Protection against a compromised application server or database administrator.
- Timing guarantees. The minimum request duration reduces timing differences but does not remove
  them.

## Reporting a vulnerability

Follow the private process in [SECURITY.md](../SECURITY.md).

Further detail: [operations](operations.md) covers secrets, budgets, pruning and redaction, and
[authentication](authentication.md) covers guard and session behaviour.
