# Managed HTTP

## Configuration

Import `registerManagedRoutes` from `adonisjs-account-kit/http` in the application's routes file. Calling it is the activation step; importing the package or configuring services registers no route. The HTTP entry requires AdonisJS Core and VineJS. Service-only applications do not import it and do not need VineJS.

Call the function once with a static absolute `prefix` such as `/api/v1`, a `kit` resolver, one existing `guard`, an explicit `enabled` capability list, and an optional `except` list of endpoint names. The guard name and strategy must match `defineConfig({ authentication })`. The `guard.forRequest(context)` callback adapts the selected AdonisJS guard to the public `AuthenticationGuard` service contract. `guard.current(context)` must authenticate that same guard and return a trusted `CurrentAccountInput`, including the captured session revision or current token identifier; it must never take identity from a body or URL. Token logout also supplies `logoutCredential(context)`. Account Kit does not create, replace, or select a guard implicitly.

```ts
import { createManagedGuard, registerManagedRoutes } from 'adonisjs-account-kit/http'

const selectedExistingGuard = createManagedGuard({
  strategy: 'session',
  name: 'web',
  loadUser: async () => (await import('#models/user')).default,
})

registerManagedRoutes(router, {
  prefix: '/api/v1',
  kit: () => app.container.make(AccountKit),
  guard: selectedExistingGuard,
  enabled: [
    'authentication',
    'registration',
    'passwordReset',
    'emailVerification',
    'emailPasswordManagement',
  ],
  except: ['auth.signup'],
})
```

The enabled names are `authentication`, `registration`, `passwordReset`, `emailVerification`, `emailPasswordManagement`, and `invitations`. Registration availability remains an explicit `registration.availability` setting in the service configuration; selecting the route does not override a closed or application-owned policy. Invitations are excluded by default until selected and authorised. One group with one guard is supported. A second registration on the same router is rejected. Path and method collisions with application routes are checked when Adonis commits routes, before the server starts handling requests; onboarding also reports known conflicts during its plan.

`extensions.registration.validate`, `extensions.invitationAcceptance.validate`, and `extensions.profile.validate` receive an `HttpContext` and return typed, validated input including optional `registrationData`. They run before a service call and outside its transaction. Service configuration owns the shared field allowlist, trusted mapping and password policy for both managed and service callers. `extensions.representAccount` receives a safe `CurrentAccount` after a service read and returns application-owned public JSON. It runs after the read; it must never add password hashes or private adapter data. A representation error propagates after the service operation; it cannot undo a committed write or an issued credential. Notifications, access policy hooks, and link destinations remain typed callbacks in `defineConfig`; their transaction and delivery semantics are documented with those public services. Replacing a route means adding its named endpoint to `except` and calling the public service from the application's controller. There is no middleware-stack replacement hook.

## How it works

### A route is available only when selected

The table lists the endpoint name, method and path after the configured prefix, required access, and normal success response. `limited` means a valid credential may belong to an inactive account; `active` applies `authentication.requireActive` and rejects that account with 403 `unverified_email`. Public routes do not accept an actor ID as authority.

| Name                              | Method and path                        | Access                        | Success                                                                                                                             |
| --------------------------------- | -------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `auth.signup`                     | POST `auth/signup`                     | public, open registration     | 201 account and limited credential; if creation committed but login cannot finish, 201 `{ registered: true, authenticated: false }` |
| `auth.csrf`                       | GET `auth/csrf`                        | public, session only          | 200 CSRF token                                                                                                                      |
| `auth.login`                      | POST `auth/login`                      | public                        | 200 safe account; token guards also receive the opaque bearer value                                                                 |
| `auth.passwordReset.request`      | POST `auth/password-reset`             | public                        | 202 identical acknowledgement for known and unknown addresses                                                                       |
| `auth.passwordReset.inspect`      | GET `auth/password-reset/:token`       | public proof                  | 200 `{ valid: true }`                                                                                                               |
| `auth.passwordReset.complete`     | POST `auth/password-reset/:token`      | public proof                  | 200 `{ reset: true }`                                                                                                               |
| `auth.emailVerification.inspect`  | GET `auth/email-verification/:token`   | public proof                  | 200 `{ valid: true }`                                                                                                               |
| `auth.emailVerification.complete` | POST `auth/email-verification/:token`  | public proof                  | 200 `{ verified: true }`                                                                                                            |
| `auth.invitation.inspect`         | GET `auth/invitations/:token`          | public proof                  | 200 invitation email and opaque role                                                                                                |
| `auth.invitation.accept`          | POST `auth/invitations/:token`         | public proof                  | 201 safe account                                                                                                                    |
| `auth.emailChange.inspect`        | GET `auth/email-change/:token`         | public proof                  | 200 `{ valid: true }`                                                                                                               |
| `auth.emailChange.complete`       | POST `auth/email-change/:token`        | public proof                  | 200 safe account                                                                                                                    |
| `account.logout`                  | POST `account/logout`                  | limited                       | 204; repeat with the ended credential is 401                                                                                        |
| `account.profile.show`            | GET `account/profile`                  | limited                       | 200 safe account                                                                                                                    |
| `account.profile.update`          | PATCH `account/profile`                | limited                       | 200 safe account                                                                                                                    |
| `account.password.change`         | POST `account/password`                | active                        | 200 `{ changed: true }`                                                                                                             |
| `account.emailVerification.send`  | POST `account/email-verification/send` | limited                       | 200 sent/already-verified result                                                                                                    |
| `account.invitation.send`         | POST `account/invitations`             | active, invitation permission | 201 invitation ID                                                                                                                   |
| `account.invitation.list`         | GET `account/invitations`              | active, list permission       | 200 bounded page                                                                                                                    |
| `account.invitation.resend`       | POST `account/invitations/:id/resend`  | active, management permission | 200 invitation ID                                                                                                                   |
| `account.invitation.revoke`       | DELETE `account/invitations/:id`       | active, management permission | 204                                                                                                                                 |

The default request validators accept only the documented fields: login `{ email, password }`; signup `{ email, password, passwordConfirmation }`; reset request `{ email }`; reset completion `{ password, passwordConfirmation }`; verification completion `{ password, passwordConfirmation }` for inactive-account claiming; invitation acceptance `{ password, passwordConfirmation }`; invitation send `{ email, role }`; password change `{ currentPassword, newPassword, newPasswordConfirmation }`; profile update `{ currentPassword, email? }`; invitation list query `{ limit?: 1..100, cursor? }`. Custom registration, invitation-acceptance and profile validators return `registrationData` for the shared field policy. Proof is read from the path for both GET inspection and POST completion. A password or bearer credential is never put in a URL.

Every package-originated error uses `{ errors: [{ code, message }] }`; with `Accept: application/vnd.api+json` it uses `{ errors: [{ code, title }] }`. Authentication failures are 401, access denial or inactive email 403, generic invalid proof 400, service conflicts 409, and limits 429 with `Retry-After`. Password and email proof codes are `E_INVALID_PASSWORD_TOKEN` and `E_INVALID_EMAIL_TOKEN`; inactive access is `unverified_email`. AdonisJS VineJS request-validation errors retain their native 422 field/rule/message shape. Internal exceptions and database messages are never serialized. Duplicate signup email uses a 422 `email`/`unique` field error without revealing the existing account state.

Login uses the configured failure-only client and identity budgets. Password-reset requests, verification sends, invitation writes, and profile/credential writes use their public services' configured limits. Every proof GET and POST also consumes a separate per-endpoint, per-client managed budget using the configured shared limiter store, secret-keyed key namespace, and `throttle` setting. Limit failure returns 429 and a rounded-up `Retry-After` value. Configure trusted proxies before `request.ip()` is used as the client key.

### Inspection never consumes proof

Proof GETs call read-only service inspection. Every proof GET and POST sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. POST completion or acceptance applies the service's atomic proof-consumption rule. Clients should treat a repeated completion as an invalid proof; request and resend operations may acknowledge repeat submissions while the underlying service limits issuance. A committed write with a failed post-commit callback remains a success response marked `{ committed: true }` when its full result is unavailable. Password-reset request always returns the same acknowledgement even when notification delivery fails after the request commits. There is no idempotency-key contract.

### The selected guard protects application routes too

Managed account routes validate the existing guard and the package's current account state on every request. The application must apply the same revision/token check to its own protected routes for revocation to cover them. Session login must regenerate the session, logout must destroy the current server-side session, and the application must use a shared server-side session store across instances. Access-token login issues an opaque token; logout deletes only the current token. See [authentication](authentication.md) for the exact revocation boundary.

## Files delta

Managed activation adds one call in the application's routes file and uses existing authentication, session, Shield, VineJS, database, and Account Kit configuration. The package maintains handlers and validators. No application controller is generated for selected standard routes. Custom fields or policy may require application-owned configuration and adapter mapping. The optional import lives at `adonisjs-account-kit/http`; the root service import stays separate.

## Manual steps

For session clients, enable Shield CSRF middleware on authentication-establishing and other state-changing routes, expose the CSRF bootstrap endpoint, send its token in `x-csrf-token`, use secure HTTP-only cookies, configure trusted proxies before deriving client IP, and set a deliberate origin/CORS policy. JSON and CORS alone do not provide CSRF protection. The managed session handlers fail closed when Shield CSRF state is absent. Configure HTTPS public origins in production.

Redact the proof-bearing path segment from access logs for `auth/password-reset/:token`, `auth/email-verification/:token`, `auth/invitations/:token`, and `auth/email-change/:token`; do not log full bearer credentials, passwords, or proofs. Supply a shared limiter store and the applicable service budgets. Choose mail delivery and, if durable delivery is required by the application, route notification callbacks through its own transactional outbox and worker. Configure explicit invitation authorisation before enabling invitation routes. Apply the selected guard's revision check to application-owned protected routes. If an endpoint is excluded, the application owns its request validation, response mapping, authentication and CSRF boundary; it may reuse the public account service.

## Changelog

See [Unreleased](../CHANGELOG.md#unreleased) for the optional managed HTTP entry and its public route contract.
