# Access-token API reference

## Configuration

Set `ACCOUNT_KIT_AUTH_STRATEGY=access_tokens` and use the existing `api` AdonisJS guard with its opaque access-token provider. The example config sets `tokenExpiresIn: '1d'` and `tokenAbilities: ['*']`; choose a shorter lifetime and narrower abilities for your application. `auth_access_tokens` must exist before token login. The example checks `invitations:create` before its invitation-send action. Other application routes must check their own required abilities.

Use HTTPS, a fixed public `APP_URL`, and trusted proxy configuration before using `request.ip()` for login limits. The configured registration-field policy and invitation authorisation callback remain application decisions.

## How it works

POST `/api/v1/auth/login` accepts `email` and `password`. A successful login issues an opaque token with the configured lifetime and abilities and returns it once in the JSON response. Send that value in `Authorization: Bearer <token>` to GET `/api/v1/account/profile` or other protected routes. The current-account response is allowlisted: it does not contain a password hash, proof, provider secret, raw provider response, or adapter internals. A limited inactive credential may reach account activation and email correction routes, while verified routes return 403 `unverified_email`.

POST `/api/v1/account/logout` deletes only the current token. The second request with that token is unauthenticated (401). It does not revoke other tokens. A package password reset, password change, confirmed-email change, activation claim, or restriction change uses package operations to revoke all of the user's tokens transactionally. Application-owned protected routes must apply the same authentication and account-access middleware to reject a token invalidated between guard authentication and route execution. Direct writes to account security columns are outside that guarantee; use the public account operations.

Password reset, activation, invitation, and email-change links use `/:token` path segments. GET inspects a proof without changing account state; POST on the same path completes it. Every proof response has `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Redact these route paths and their token segments from access, proxy, tracing, and error logs: `/account-kit/recovery/:token`, `/account-kit/verification/:token`, `/account-kit/invitation/:token`, and `/account-kit/email-change/:token`. Never put bearer credentials in URLs or logs. Client storage is an application threat-model decision; this example does not provide a browser token-storage SDK.

Package-originated errors use `{ "errors": [{ "code": "...", "message": "..." }] }`. With `Accept: application/vnd.api+json`, the entry uses `title` in place of `message`. Authentication failures are 401, forbidden or unverified access 403, invalid proofs 400, conflicts 409, and rate limits 429. Request-schema failures retain AdonisJS Vine's 422 response. Proof failures share a generic message, including missing, expired, replayed, or mismatched proofs. A committed operation with failed notification delivery remains a success response; inspect server diagnostics and the delivery outbox rather than retrying the mutation blindly.

## Files delta

`app/controllers/access_tokens_controller.ts` adapts package login and logout to the existing guard. The password-resets, email-verifications, invitations, account-password, and profile controllers adapt the account flows. `app/services/http_responses.ts` shapes HTTP errors and proof headers, and `app/exceptions/handler.ts` maps package exceptions. `app/middleware/account_access_middleware.ts` and `app/middleware/verified_account_middleware.ts` gate application-owned routes. `start/routes.ts` selects the guard and exposes the reference endpoints. Functional tests exercise the installed archive on SQLite and PostgreSQL.

## Manual steps

Provision the token table and migrations, configure real notification delivery and URL destinations, select a suitable token lifetime and abilities, and protect every application-owned route that relies on revocation or active-account state. Redact proof paths and the Authorization header in all infrastructure logs. Operate the notification worker/outbox according to the application's delivery requirements. Run the packed consumer checks on both supported databases after changing guard or account configuration.

## Changelog

See the [Unreleased entry](../../CHANGELOG.md#unreleased) for the token reference HTTP contract.
