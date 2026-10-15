# Session reference integration

## Configuration

Set `ACCOUNT_KIT_AUTH_STRATEGY=session` to select the existing `web` guard. Configure a shared server-side `SESSION_DRIVER` for a multi-instance deployment; the fixture uses `memory` only in single-process tests and rejects `cookie` because logout could not invalidate a replayed self-contained cookie. The example disables remember-me tokens and sets its session cookie to `httpOnly`, `sameSite: 'lax'`, and `secure` in production. Use HTTPS for `APP_URL`, configure trusted proxies before relying on `request.ip()`, and allow only trusted browser origins in production CORS configuration. Cookie-backed requests require Shield CSRF protection, including unauthenticated login and signup.

## How it works

First request `GET /api/v1/auth/csrf`; the response supplies a CSRF token and an HTTP-only session cookie and has `Cache-Control: no-store`. Send that cookie and the token in `x-csrf-token` on every state-changing request. Login uses `kit.authentication.login` with the existing `web` guard, regenerates the session identifier, and records the account's credential revision. It does not put credentials in a URL or return a bearer token. A failed login has the same public response whether the account is missing, passwordless, disabled, or the password is wrong. The service counts failures under both client and normalized-identity limits; successful attempts do not spend either failure budget.

An inactive account may use routes guarded by `AccountAccessMiddleware`, such as activation send and unconfirmed-email correction. `VerifiedAccountMiddleware` additionally requires an active account on protected routes. The application-owned `/api/v1/account/profile` route uses the access middleware and returns the package's safe current-account projection. Apply the appropriate middleware to every application-owned route needing these guarantees. A route without it has no session-revision or restriction check.

Package password reset, password change, confirmed-email change, and restriction changes advance `credentials_changed_at`. The middleware compares that database value with the revision captured at login, so all pre-existing sessions are rejected on protected routes across instances sharing the database. Login also rechecks revision before returning access, rejecting a credential established from superseded evidence. Direct application writes to credentials, email, verification state, restrictions, or provider rows are outside these guarantees; use package operations.

`POST /api/v1/account/logout` ends the current server-side session. It does not revoke every credential. The old cookie is rejected; after a fresh CSRF bootstrap, a repeated authenticated logout returns 401. A repeat with the old CSRF token can fail CSRF validation first with 403.

## Files delta

`app/controllers/session_controller.ts` adapts the existing guard and exposes CSRF bootstrap. `app/middleware/account_access_middleware.ts` and `app/middleware/verified_account_middleware.ts` gate application-owned and package-backed routes. `config/auth.ts`, `config/session.ts`, `config/shield.ts`, and `config/cors.ts` show the guard, cookie, CSRF, and origin settings. `tests/functional/authentication_session.spec.ts` exercises the browser flow and revocation on an application-owned route.

## Manual steps

Choose a shared server-side session store, trusted proxy policy, HTTPS origin, production CORS allowlist, and cookie scope for the deployment. Apply the users-table credential-revision migration before accepting new sessions. Protect all application-owned routes that need revocation or active-account checks. Redact proof path segments in access logs; proof links use `/:token`, and proof responses must be non-cacheable with `Referrer-Policy: no-referrer`. Run the installed-consumer tests for SQLite and PostgreSQL with `ACCOUNT_KIT_AUTH_STRATEGY=session` coverage.

## Changelog

The [Unreleased changelog](../../CHANGELOG.md#unreleased) records the session reference and non-cacheable CSRF bootstrap.
