# Decisions

## Departures

1. VOC-1. `authentication.sessions.*`, the `sessions.revoked` and `sessions.revoked_all` events, `SessionsRevokedContext`, `E_ACCOUNT_KIT_SESSION_NOT_FOUND`, `E_ACCOUNT_KIT_INVALID_SESSION`, the `'sessionManagement'` capability, `onSessionsRevokedTransaction`, and `PasswordLoginInput.sessionLabel` name every place a user is signed in "sessions", including access-token rows under the access-token strategy. The names stay as they are.
2. PKG-31, PKG-47. `AccountKitSessionGuard` extends `@adonisjs/auth/session`'s `SessionGuard` and throws `@adonisjs/auth`'s `errors.E_UNAUTHORIZED_ACCESS` from `authenticate()` when a session fails Account Kit checks, because `SessionGuard.check()` and AdonisJS auth middleware catch `E_UNAUTHORIZED_ACCESS` as part of the `@adonisjs/auth` guard contract.
3. IMP-6 (#1071). `src/setup/migration_source.ts` constructs a bare `Application` rooted at the package stubs to render migration templates, because setup does not boot the host application and must not read its stubs. `IgnitorFactory().createApp()` would replace the global `@adonisjs/core/services/app` during `node ace account-kit:setup`.
