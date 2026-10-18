# Security model

This page lists what Account Kit defends against, how, and what remains the application's job. It
describes the package defaults; each value in the tables can be changed in `config/account_kit.ts`.

## What the package defends against

| Threat                                     | Defence                                                                                                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen database rows used as reset links   | Proof tokens are 40 random bytes (`tokenSecretLength`, 16–64). Only their SHA-256 hash is stored.                                                                                                                                            |
| Replayed or old links                      | Every proof is single use and expires: password reset, email verification and email change after 1 hour, invitations after 7 days (`expiresIn`). Use and expiry are checked inside the write transaction.                                    |
| Account enumeration through password reset | `passwordReset.request` returns the same result for known and unknown addresses and waits out a minimum request duration (`minRequestMs`, 300 ms) on every exit.                                                                             |
| Account enumeration through login          | Absent accounts, wrong passwords, restricted accounts and accounts without a password produce the same error.                                                                                                                                |
| Brute force and mail flooding              | Recovery requests are limited per client and per address (5 per 15 minutes, `throttle`). Invitations have separate actor and recipient budgets (`invitationThrottle`). Login has client and identity limits with a block period.             |
| Limiter keys leaking addresses             | Limiter keys are HMAC-SHA256 digests under a key derived from `limiterSecret` with HKDF, so the limiter store never holds an email address or IP in plain text.                                                                              |
| Host-header poisoning of links             | Action URLs are built only from configured origins and relative destinations. Request `Host` and forwarded headers are never used. Production origins must be HTTPS.                                                                         |
| Sessions surviving a credential change     | Password reset, password change, email change, access restriction and social unlink advance the user's credential revision in the same transaction. The session guard rejects older revisions and the token guard deletes the user's tokens. |
| Partial writes and races                   | Each operation runs in one package-owned transaction. PostgreSQL locks the user row; SQLite serializes package writes through a lock row.                                                                                                    |
| Social login account takeover              | Linking needs a verified provider email or recent proof, one provider subject maps to one user, the handoff code is single use with PKCE, and an account cannot remove its last sign-in method.                                              |
| Stored HTML in email                       | Built-in templates escape every value, and action URLs must be absolute HTTP(S) URLs without credentials.                                                                                                                                    |

## What the application must do

- **Keep secrets stable and secret.** `APP_KEY` must be at least 32 bytes and identical on every
  instance that shares a limiter store. Rotating `limiterSecret` resets rate-limit budgets.
- **Configure trusted proxies before deriving `clientKey` from the request IP.** Never accept a
  client key supplied by the caller or an unverified `X-Forwarded-For` value.
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
