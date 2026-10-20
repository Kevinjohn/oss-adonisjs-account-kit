# Managed HTTP

Account Kit can mount its own JSON routes for every enabled flow, so you write no controllers.
The rest of this page is the full contract; start with the smallest working mount.

## Quick start

This mounts login and password reset under `/api` for the access-token guard in the AdonisJS API
starter kit. Add the guard to `config/account_kit.ts`:

```ts
authentication: { strategy: 'access_tokens', guard: 'api' },
```

Create the route file:

```ts
// start/account_kit_routes.ts
import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import { createManagedGuard, registerManagedRoutes } from 'adonisjs-account-kit/http'

registerManagedRoutes(router, {
  prefix: '/api',
  enabled: ['authentication', 'passwordReset'],
  kit: () => app.container.make(AccountKit),
  guard: createManagedGuard({
    strategy: 'access_tokens',
    name: 'api',
    loadUser: async () => (await import('#models/user')).default,
  }),
})
```

Import it at the end of `start/routes.ts`:

```ts
import './account_kit_routes.js'
```

`node ace list:routes` now shows `POST /api/auth/login`, `POST /api/auth/password-reset` and the
other endpoints for those groups. Add groups to `enabled` as you turn on more capabilities; the
[endpoint reference](reference/endpoints.md) lists them. Emailed links still come from `urls` in
the config: point them at your frontend pages, which post to these routes. A session guard also
needs the `config/session.ts` wrapper described below.

## Configuration

Import `registerManagedRoutes` from `adonisjs-account-kit/http` in the application's routes file. Calling it is the activation step; importing the package or configuring services registers no route. The HTTP entry requires AdonisJS Core and VineJS. Service-only applications do not import it and do not need VineJS.

Call the function once with a static absolute `prefix` such as `/api/v1`, a `kit` resolver, one existing `guard`, an explicit `enabled` capability list, and an optional `except` list of endpoint names. The guard name and strategy must match `defineConfig({ authentication })`. The `guard.forRequest(context)` callback adapts the selected AdonisJS guard to the public `AuthenticationGuard` service contract. `guard.current(context)` must authenticate that same guard and return a trusted `CurrentAccountInput`, including the captured session revision or current token identifier; it must never take identity from a body or URL. Token logout also supplies `logoutCredential(context)`. Account Kit does not create, replace, or select a guard implicitly. For session guards, protect the selected session configuration before Adonis creates its session middleware. The wrapper checks the exact store instance used by the request and rejects native cookie-backed stores, including aliases and subclasses: an old self-contained cookie can replay after logout. The required `verifyStore` callback is trusted application configuration that attests central revocation for the actual non-cookie store. It must reject unknown or unverified custom stores. Use a shared server-side store across application instances. An unprotected session configuration fails closed with a setup error.

In `config/session.ts`, wrap the `defineConfig(...)` provider before exporting it:

```ts
import { defineConfig, stores } from '@adonisjs/session'
import { protectManagedSessionConfig } from 'adonisjs-account-kit/http'
import { isTrustedRevocableSessionStore } from '#services/session_store_policy'

const sessionConfig = defineConfig({
  // Keep the application's cookie, age, store and stores settings here.
  store: 'database',
  stores: { database: stores.database(), cookie: stores.cookie() },
})

export default protectManagedSessionConfig(sessionConfig, {
  verifyStore: (actual) => {
    // Attest the configured server-side implementation's destroy/revocation behavior.
    // Reject an implementation whose destroyed IDs can still be replayed.
    return isTrustedRevocableSessionStore(actual)
  },
})
```

`isTrustedRevocableSessionStore` is an application-owned check for the selected store implementation; a method named `destroy` alone does not establish revocation. The wrapper is resolved at boot, before `SessionMiddleware` captures the configuration. It invokes the selected factory once for each request, validates and returns that exact store, and binds proof to the request and configuration. Install it even when the selected store key is an alias or the canonical `cookie` key has been replaced by a server-backed factory. Direct callers who omit the wrapper receive an actionable fail-closed error from `createManagedGuard`.

```ts
import { createManagedGuard, registerManagedRoutes } from 'adonisjs-account-kit/http'

const selectedExistingGuard = createManagedGuard({
  strategy: 'session',
  name: 'web',
  loadUser: async () => {
    const { default: User } = await import('#models/user')
    return User
  },
})

registerManagedRoutes(router, {
  prefix: '/api/v1',
  kit: () => app.container.make(AccountKit),
  guard: selectedExistingGuard,
  verificationRequired: true,
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

The enabled names are `authentication`, `registration`, `passwordReset`, `magicLinkLogin`, `emailVerification`, `emailPasswordManagement`, `invitations`, `socialAuthentication`, `sessionManagement`, `dataExport`, and `accountDeletion`. Magic-link routes are described in [magic-link sign-in](magic-link.md); sign-in management routes in [signed-in devices](signed-in-devices.md); export and deletion routes in [account export and deletion](account-data.md). `verificationRequired` defaults to `true`. Setting it to `false` permits an unverified account on routes marked `active`; the selected guard, credential revision, restriction, and invitation permission checks still apply. Use the same setting in `managedAccountMiddleware({ active })` on application-owned routes. Registration availability remains an explicit `registration.availability` setting in the service configuration. Managed signup accepts only `open`; `closed` and `application` reject before calling registration. An application-owned signup decision must exclude `auth.signup` and call the public registration service from its trusted controller. Invitations are excluded by default until selected and authorized. One group with one guard is supported. A second registration on the same router is rejected. Path and method collisions with application routes are checked when Adonis commits routes, before the server starts handling requests; onboarding also reports known conflicts during its plan. The social group requires `extensions.social.providers` and follows [the managed social contract](managed-social.md).

`extensions.registration.validate`, `extensions.invitationAcceptance.validate`, and `extensions.profile.validate` receive an `HttpContext` and return typed, validated input including optional `registrationData`. They run before a service call and outside its transaction. Service configuration owns the shared field allowlist, trusted mapping and password policy for both managed and service callers. `extensions.representAccount` receives a safe `CurrentAccount` after a service read and returns application-owned public JSON. It runs after the read; it must never add password hashes or private adapter data. A representation error after credential issuance or an account mutation is logged and the response uses the package's safe account allowlist, preserving the committed result. A representation error on a read-only route propagates. `extensions.message(code, defaultMessage)` may change public error wording without changing the status or machine code; it receives no exception or database details and runs during response mapping. Notifications, access policy hooks, and link destinations remain typed callbacks in `defineConfig`; their transaction and delivery semantics are documented with those public services. Replacing a route means adding its named endpoint to `except` and calling the public service from the application's controller. For setup-generated mounts, record exclusions in the setup input's `managedExcept` list so regeneration preserves them; direct callers pass `except` to `registerManagedRoutes`. There is no middleware-stack replacement hook.

### OpenAPI document

`node ace account-kit:openapi` prints an OpenAPI 3.1 document for the mounted routes, and
`generateManagedOpenApi` builds it from code. Applications that replace a validator or set
`representAccount` pass the matching schemas in the `openapi` option. See [OpenAPI document](openapi.md).

## How it works

### A route is available only when selected

The table lists the endpoint name, method and path after the configured prefix, required access, and normal success response. The exported `ManagedRequestBodies`/`ManagedRequestBody<Name>`, `ManagedQueries`/`ManagedQuery<Name>`, and `ManagedSuccessBodies`/`ManagedSuccessBody<Name>` types describe default JSON bodies, query parameters, and success bodies (including `202 { committed: true }` for applicable writes); VineJS validators enforce request schemas. Named route and response tests cover this inventory. `limited` means a valid credential may belong to an inactive account; `active` applies `authentication.requireActive` when `verificationRequired` is true and rejects that account with 403 `E_ACCOUNT_KIT_UNVERIFIED_EMAIL`. Public routes do not accept an actor ID as authority.

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

The default request validators accept only the documented fields: login `{ email, password }`; signup `{ email, password, passwordConfirmation, registrationData? }`; reset request `{ email }`; reset completion `{ password, passwordConfirmation }`; verification completion `{ password, passwordConfirmation }` for inactive-account claiming; invitation acceptance `{ password, passwordConfirmation, registrationData? }`; invitation send `{ email, role }`; password change `{ currentPassword?, recentProof?, newPassword, newPasswordConfirmation }`; profile update `{ currentPassword?, recentProof?, email?, registrationData? }`; invitation list query `{ limit?: 1..100, cursor? }`. The shared service requires the actual current password when an account has one; a caller cannot bypass that requirement with `recentProof`. For a provider-only account, it consumes a purpose-bound recent proof (`password_change` or `email_change`) inside the same transaction. With standard Ally adapters, establish a first password through reset, sign in with it, then re-enter that password for later sensitive changes. Optional `registrationData` must be an object; its keys and values pass to the shared service field mapper, which validates the configured allowlist and trusted adapter mapping. Custom registration, invitation-acceptance and profile validators may enforce a stricter application schema before the same shared field policy. Every newly established password is checked against the same configured `passwordPolicy` as the public services before a write; policy rejection is a 422 field error with rule `passwordPolicy`, never a false invalid-proof error. Proof is read from the path for both GET inspection and POST completion. A password or bearer credential is never put in a URL.

Every package-originated error uses `{ errors: [{ code, message }] }`; when a client accepts `application/vnd.api+json` with positive quality at least as high as JSON, it uses `{ errors: [{ code, title }] }` and sets that response content type. Authentication failures are 401, access denial or inactive email 403, generic invalid proof 400, configured field-policy rejection 422 with code `E_ACCOUNT_KIT_INVALID_INPUT`, service conflicts 409, and limits 429 with `Retry-After`. Password, email and sign-in link proof codes are `E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN`, `E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN` and `E_ACCOUNT_KIT_INVALID_MAGIC_LINK`; inactive access is `E_ACCOUNT_KIT_UNVERIFIED_EMAIL`; rejected current identity proof is `E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED`. Negotiated error responses include `Vary: Accept`. AdonisJS VineJS request-validation errors retain their native 422 field/rule/message shape. Internal exceptions and database messages are never serialized. Recovery diagnostics contain only the endpoint name and outcome (`delivery_failed`, `followup_failed`, `authentication_failed`, or `representation_failed`), with no submitted secrets or proof URL. Duplicate signup email uses a 422 `email`/`unique` field error without revealing the existing account state.

Managed signup consumes a shared, secret-keyed per-client `auth.signup` budget before creation using the configured `throttle` setting; a limit rejects without creating an account. Login uses the configured failure-only client and identity budgets. Password-reset requests, verification sends, invitation writes, and profile/credential writes use their public services' configured limits. Every proof GET and POST also consumes a separate per-endpoint, per-client managed budget using the configured shared limiter store, secret-keyed key namespace, and `throttle` setting. Limit failure returns 429 and a rounded-up `Retry-After` value. Configure trusted proxies before `request.ip()` is used as the client key.

### Inspection never consumes proof

For any non-empty selected session capability set, managed routes include `auth.csrf` unless its endpoint name is explicitly excluded; token selections never include it. Proof GETs call read-only service inspection. Every proof GET and POST sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. The `auth.csrf` response also sets `Cache-Control: no-store`, so a shared cache cannot replay one session's CSRF token to another client. Install `managedProofHeadersMiddleware({ prefix, strategy, enabled, except })` in the application's early server middleware, before body parsing and Shield, with the same route selection as `registerManagedRoutes`. This ensures parser and CSRF failures on proof URLs retain those headers; handler-level headers alone run too late. POST completion or acceptance applies the service's atomic proof-consumption rule. Clients should treat a repeated completion as an invalid proof; request and resend operations may acknowledge repeat submissions while the underlying service limits issuance. A committed write with a failed post-commit callback remains a success response marked `{ committed: true }` when its full result is unavailable. Password-reset request always returns the same acknowledgement even when notification delivery fails after the request commits. There is no idempotency-key contract. A GET profile, invitation list, proof inspection, or CSRF bootstrap can be repeated without a write. A successful login creates a new session/token; repeat only if a new credential is wanted. A duplicate signup returns the same `email`/`unique` 422 regardless of account state; after an uncertain signup result, reconcile by login or recovery instead of assuming rollback. A repeated logout returns 401. Proof completion and invitation acceptance are one-use and reject a second submission. Password reset request returns the same acknowledgement on retries, while verification resend and invitation resend follow their service limits; an uncertain profile, password, or invitation write should be reconciled with the account/invitation read or recovery flow before retrying. A `202 { committed: true }` means the write committed but a post-commit callback failed; clients should reconcile current state, not repeat blindly.

### Error messages follow the application's language

When the application uses [`@adonisjs/i18n`](https://docs.adonisjs.com/guides/digging-deeper/i18n) and its locale middleware sets `ctx.i18n`, managed routes translate every `{ code, message }` error the same way the official AdonisJS packages do. The message for code `X` is looked up as `errors.X`. When neither the request's locale nor its configured fallback locale has the key, the English message below is used, and `@adonisjs/i18n` emits its `i18n:missing:translation` event. Codes and statuses never change. Without `@adonisjs/i18n`, responses stay in English. `extensions.message` still runs last and receives the translated message as its default.

`E_INVALID_CREDENTIALS` is the same key `@adonisjs/auth` uses, so an existing translation covers both packages.

Clients that translate on their side should key on `code`, which is a stable contract; see [error code stability](reference/errors.md#stability).

The middleware generated by `@adonisjs/i18n` picks the locale from the `Accept-Language` header. For one site-wide language, return it from `getRequestLocale` in `app/middleware/detect_user_locale_middleware.ts` and keep the rest of the middleware, which also installs the validation messages provider:

```ts
protected getRequestLocale() {
  return 'fr'
}
```

Copy this file to `resources/lang/<locale>/errors.json` and translate the values:

```json
{
  "E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN": "This link is invalid or expired.",
  "E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN": "This link is invalid or expired.",
  "E_ACCOUNT_KIT_INVALID_INVITATION_TOKEN": "This link is invalid or expired.",
  "E_ACCOUNT_KIT_INVALID_MAGIC_LINK": "This link is invalid or expired.",
  "E_INVALID_CREDENTIALS": "Authentication failed.",
  "E_ACCOUNT_KIT_UNVERIFIED_EMAIL": "Email verification is required.",
  "E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED": "Current identity proof could not be confirmed.",
  "E_ACCOUNT_KIT_INVITATION_NOT_FOUND": "Invitation not found.",
  "E_ACCOUNT_KIT_FORBIDDEN": "Access denied.",
  "E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED": "The account request conflicts with an existing account.",
  "E_ACCOUNT_KIT_THROTTLED": "Too many requests.",
  "E_ACCOUNT_KIT_INVALID_INPUT": "Account request rejected.",
  "E_ACCOUNT_KIT_SESSION_NOT_FOUND": "Account request rejected.",
  "E_ACCOUNT_KIT_USER_NOT_FOUND": "Account request rejected.",
  "E_ACCOUNT_KIT_NO_PASSWORD": "Account request rejected.",
  "E_ACCOUNT_KIT_INVITATION_PENDING": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD": "Account request rejected.",
  "E_ACCOUNT_KIT_OPERATION_FAILED": "Account operation failed."
}
```

Request-validation messages already follow the locale: the managed routes call `request.validateUsing`, which uses the messages provider the i18n middleware installs. Two 422 messages come from checks the package runs after validation. They use the keys the `@adonisjs/i18n` VineJS messages provider reads: `validator.shared.messages.<rule>`, with `{field}` taken from `validator.shared.fields.<field>`. Add them to `resources/lang/<locale>/validator.json`:

```json
{
  "shared": {
    "messages": {
      "unique": "The {field} has already been taken.",
      "passwordPolicy": "The {field} does not meet the password policy."
    },
    "fields": {
      "email": "email",
      "password": "password",
      "passwordConfirmation": "password confirmation",
      "currentPassword": "current password",
      "newPassword": "new password",
      "newPasswordConfirmation": "new password confirmation",
      "role": "role"
    }
  }
}
```

`shared.fields` names the fields people fill in; translate those names too. The other managed fields are sent by client code.

Community [translations](translations/index.md) of both files are ready to copy.

The password-reset and magic-link requests answer `202` with an acknowledgement looked up as `account_kit.<key>`. Add them to `resources/lang/<locale>/account_kit.json`:

```json
{
  "password_reset_requested": "If the account exists, instructions will be sent.",
  "magic_link_requested": "If the account exists, a sign-in link will be sent."
}
```

### The selected guard protects application routes too

Managed account routes validate the existing guard and the package's current account state on every request. The application must apply the same revision/token check to its own protected routes for revocation to cover them. Session login must regenerate the session, logout must destroy the current server-side session, and the application must use a shared server-side session store across instances. Access-token login issues an opaque token; logout deletes only the current token. See [authentication](authentication.md) for the exact revocation boundary.

## Files and migrations

Managed activation adds one call in the application's routes file and uses existing authentication, session, Shield, VineJS, database, and Account Kit configuration. The package maintains handlers and validators. No application controller is generated for selected standard routes. Custom fields or policy may require application-owned configuration and adapter mapping. The optional import lives at `adonisjs-account-kit/http`; the root service import stays separate.

## Before deployment

For session clients, enable Shield CSRF middleware on authentication-establishing and other state-changing routes, use the managed CSRF bootstrap endpoint (or supply an application-owned replacement when `auth.csrf` is excluded), send its token in `x-csrf-token`, use secure HTTP-only cookies, configure trusted proxies before deriving client IP, and set a deliberate origin/CORS policy. JSON and CORS alone do not provide CSRF protection. The managed session handlers fail closed when Shield CSRF state is absent. Configure HTTPS public origins in production.

Redact the proof-bearing path segment from access logs for `auth/password-reset/:token`, `auth/email-verification/:token`, `auth/invitations/:token`, and `auth/email-change/:token`; do not log full bearer credentials, passwords, or proofs. Supply a shared limiter store and the applicable service budgets. Choose mail delivery and, if durable delivery is required by the application, route notification callbacks through its own transactional outbox and worker. Configure explicit invitation authorization before enabling invitation routes. Send/resend permission is checked when the invitation is issued; acceptance validates the live invitation and recipient proof, but does not automatically re-check whether the inviter still has permission. Revoke outstanding invitations when an inviter loses that authority if your application requires it. Apply the selected guard's revision check to application-owned protected routes. If an endpoint is excluded, the application owns its request validation, response mapping, authentication and CSRF boundary; it may reuse the public account service.
