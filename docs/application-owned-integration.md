# Application-owned integration

Use this guide when the application owns its HTTP routes and controllers and calls Account Kit's
public account operations. Account Kit does not register these routes, choose the application's
response format, or replace its authentication guard. The [API consumer example](../examples/api/README.md)
shows a complete AdonisJS application. Its [route table](../examples/api/start/routes.ts),
[session reference](../examples/api/SESSION.md), and
[access-token reference](../examples/api/TOKENS.md) give the concrete paths, payloads, guard setup,
and responses this guide summarizes.

## Configuration

Configure the user adapter, enabled capabilities, registration availability, password policy,
authorization and notification callbacks in `config/account_kit.ts` with `defineConfig`. The API
example uses a lazy Lucid user adapter and explicitly maps validated registration data; it never
spreads request fields onto the user model. Match application validators to the shared 8–256
UTF-16-unit service password bounds and any configured `passwordPolicy`. See the
[example configuration](../examples/api/config/account_kit.ts), [registration guide](registration.md),
and [service configuration guide](usage.md#configuration) for options and defaults. For maintained
mail, use `createActionUrls` with fixed public backend and frontend origins and
`createMailNotifications` with the application's sender; configure `delivery` as
`best-effort` or declare `durable` only after the application worker meets the documented checks.
See [account notifications](notifications.md) for the full Mail contract.

The package provider does not generate or automatically register these example routes. The API
fixture owns them under `/api/v1`:

| Route                                                                                                                                                            | Application responsibility                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/signup`, `POST /api/v1/auth/login`                                                                                                            | Validate credentials and profile fields; register through the service and establish the selected guard.  |
| `GET /api/v1/auth/csrf`                                                                                                                                          | Session mode only: return a non-cacheable CSRF token and session cookie.                                 |
| `POST /api/v1/auth/password-reset`, `GET`/`POST /api/v1/auth/password-reset/:token`                                                                              | Return a generic request acknowledgement; inspect without consuming, then complete explicitly.           |
| `GET`/`POST /api/v1/auth/email-verification/:token`                                                                                                              | Inspect without consuming, then activate with a fresh password.                                          |
| `GET`/`POST /api/v1/auth/email-change/:token`, `GET`/`POST /api/v1/auth/invitations/:token`                                                                      | Inspect links without consuming; complete only after explicit client action.                             |
| `GET`/`PATCH /api/v1/account/profile`, `POST /api/v1/account/password`, `POST /api/v1/account/email-verification/send`                                           | Authenticate the actor, apply account-access or verified-account middleware, and allowlist the response. |
| `POST /api/v1/account/logout`, `POST`/`GET /api/v1/account/invitations`, `POST /api/v1/account/invitations/:id/resend`, `DELETE /api/v1/account/invitations/:id` | Apply the selected guard and application invitation authorization.                                       |

The fixture selects either the existing `web` session guard or `api` access-token guard through
`ACCOUNT_KIT_AUTH_STRATEGY`.

Account Kit is available from the AdonisJS container after its provider is configured:

```ts
import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'

const kit = await app.container.make(AccountKit)
```

Keep each route's middleware and capability selection explicit. Apply the selected authentication
integration before loading an actor, and apply verified-account or application authorization checks
where the operation requires them. The [authentication guide](authentication.md) and the two
reference guides document CSRF, session revision checks, token revocation, and route protection.

## How it works

### Validate requests before calling account operations

Use AdonisJS validators to normalize and validate request bodies, query values, and route
parameters. Pass only the validated fields required by the operation. For authenticated actions,
derive `actorId` from the authenticated user; never accept a caller-supplied identifier as proof of
authority. The example's [validators](../examples/api/app/validators) and
[named controllers](../examples/api/app/controllers) show this boundary.

For example, validate a password change and derive its actor from the authenticated guard before
calling the service:

```ts
const actor = await auth.getUserOrFail()
const { currentPassword, newPassword } = await request.validateUsing(credentialChangeValidator)
const kit = await app.container.make(AccountKit)

await kit.emailPasswordManagement.changePassword({
  actorId: actor.id,
  currentPassword,
  newPassword,
})

return response.ok({ changed: true })
```

The example's [password-change action](../examples/api/app/controllers/account_password_controller.ts)
uses this service contract.

The signup route follows the same boundary: validate the email, password, confirmation and
application fields, then call `kit.registration.register({ email, password, registrationData })`.
The package creates the inactive account and hashed activation proof together. Map
`RegistrationEmailAlreadyRegisteredError` to the same email-field validation response for every
existing account state. If link delivery or a post-commit observer fails, the account has already
committed; return the documented recovery guidance and do not retry registration as if it rolled
back. The [registration guide](registration.md) documents the capability and its admission modes.

### Keep HTTP policy in the application

Controllers choose status codes, response bodies, and route middleware. The reference exception
handler uses `accountErrorResponse` for stable package codes, safe messages, and `Retry-After` on
throttling. The mapper marks committed failures for controller handling; the example does not expose
that marker in its public error envelope. Package errors become
`{ errors: [{ code, message }] }`, or `{ errors: [{ code, title }] }` when the client accepts
JSON:API. Invalid credentials map to 401; request-schema failures remain Vine 422 responses.
Successful login returns 200 and throttled login returns 429 with `Retry-After`. Duplicate signup is
also a Vine 422, deliberately using the same email-field response for every existing account state:
`{ errors: [{ field: 'email', rule: 'unique', message: 'The email has already been taken' }] }`.
Password-reset requests and completions return 202, including committed delivery failures; signup
returns 200 after guard establishment or 202 with recovery guidance after account commit. Proof
inspection succeeds with 200 and invalid, expired, replayed, or mismatched proofs return a generic
400 with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Do not return internal causes
or log proofs, full URLs, passwords, provider data, or unnecessary personal data.

At the HTTP boundary, return the same 404 code and body for an invitation that is missing and one
the actor is not authorized to manage. The service may retain separate exceptions for private
diagnosis.

For example, an invalid login is a 401 with code `E_ACCOUNT_KIT_INVALID_CREDENTIALS`; the same
safe response covers a missing account, wrong password, passwordless account, or denied access.
Proof failures use `E_INVALID_PASSWORD_TOKEN` or `E_INVALID_EMAIL_TOKEN` as appropriate. The
request validator remains the source of field-level 422 errors.

Preserve operation-specific disclosure rules. Password-reset requests return the same acknowledgement
for known and unknown addresses, even after committed notification failure. A throttled request
does not replace the live reset proof; a later successful issuance rotates it. Proof tokens travel
in path segments, so redact proof paths, full URLs, and `Authorization` headers from application,
proxy, tracing, and error logs. For committed failures, use a safe operation marker in application
logs and return the success or recovery response appropriate to that operation; do not retry a
mutation as if it rolled back. See
[HTTP and error handling](usage.md#http-and-error-handling),
[token responses](../examples/api/TOKENS.md#how-it-works), and
[notifications](notifications.md) for the current contracts.

### Let package operations own account writes

Call the public operation for registration, password resets, email verification, invitations, and
email or password changes. Login calls `kit.authentication.login` with an adapter for the selected
existing AdonisJS guard. Keep related application writes in package transaction callbacks and use
the provided `trx`. Do not put package writes inside an application-wide transaction or call
external services from transaction callbacks. The [registration guide](registration.md) and
[authentication guide](authentication.md) describe these service contracts.

Activation completion uses `emailVerification.complete({ token, password })`: the address owner
sets a fresh password, replacing the pre-verification password. The selected guard adapter then
rejects credentials issued before that proof. Apply `VerifiedAccountMiddleware` to protected routes
until the account is active. The new-password ceiling applies across registration, reset, invitation
acceptance, activation, and password changes; login remains compatible with existing passwords.

The application owns notification transport. Maintained AdonisJS Mail callbacks use `sendLater`
after the account operation commits; this queues according to the application's Mail transport,
not an Account Kit outbox. The default best-effort mode does not retry a lost or failed message.
Failures before queue acceptance surface as `DeliveryError` or `PostCommitError` after commit; a
later Mail transport failure is reported by Mail. Log only safe operation IDs and message kinds.
`onLifecycleEvent` carries safe event identifiers and operation IDs after commit; keep those
diagnostics separate from message URLs and delivery payloads.
For durable delivery, persist an application outbox intent transactionally and deliver it from an
application worker. The [notification guide](notifications.md) defines the durability boundary and
required worker behavior; the fixture's sample dispatcher is not production outbox infrastructure.

### Replace one route at a time

When an application needs different policy or response behavior, keep that route application-owned
and call the relevant public operation from its controller. For example, replacing
`PATCH /api/v1/account/profile` still calls `emailPasswordManagement.updateProfile` with the guard's
actor ID and returns an explicit allowlist of account fields. Retain the route's authorization,
validation, proof redaction, and response disclosure checks; other routes can keep their existing
controllers. The [service usage guide](usage.md) lists public operations and the
[compatibility guide](compatibility.md) states the supported adapter and database boundary.

## Files delta

The application owns its routes, controllers, validators, exception handler, authentication
middleware, user model, and notification delivery. Configure adds the package provider,
`config/account_kit.ts`, and package migrations when those files are absent. The
[API consumer fixture](../examples/api) shows these files together. Package setup does not register
the fixture's HTTP routes; resolving `AccountKit` only provides its services.

## Manual steps

1. Configure capabilities and `registration.availability`, align the application password
   validator with `passwordPolicy` and the shared service bounds, then review generated config and
   migrations before applying them.
2. Select the existing `web` session or `api` access-token guard. For session mode, configure a
   server-side store and CSRF middleware; for both modes, set trusted proxies before deriving
   limiter keys and protect every application-owned route.
3. Define request validators, middleware, response schemas, and authorization policy in the
   application. Derive actor identity from the selected guard.
4. Map each HTTP action to a public service operation. Keep account writes in package transactions,
   use `trx` for related application writes, and move durable notification delivery to an
   application-owned worker.
5. Exercise the enabled lifecycle against the installed package and selected database. Keep the
   frontend, public origins, mail transport, and deployment configuration in application scope.

### Developer evaluation protocol

Run an initial service walkthrough in M1 and refine it with the documented reference applications
in M2. Use those findings to refine onboarding targets and record this protocol by the end of M2,
before M3 starts. Keep the task set, success rule, and failure treatment below fixed before M3 so
criteria are not selected retrospectively for the final managed-backend evaluation.

The preferred final evaluation uses three to five developers, including at least one developer new
to AdonisJS and one familiar with it. Permitted guidance is the published documentation only; do not
provide author or maintainer implementation help or rely on undocumented application code to
complete a task. The product owner is accountable for the evaluation and success criteria; the
technical maintainer validates that the tasks are feasible against the supported application.

If those participants are unavailable for this run, the product owner has approved a documented
technical walkthrough as the fallback. It uses the same four tasks:

1. Configure a supported conventional AdonisJS application using the published documentation.
2. Explain the setup changes and the responsibilities that remain with the application.
3. Exercise the enabled account lifecycle through the application's routes.
4. Replace one endpoint while preserving the other enabled routes.

For both evaluation modes, the permitted written guidance is the published documentation, including
the maintained reference application. No author or maintainer implementation help, source inspection
as a substitute for missing documentation, or undocumented application code may supply a task step.
Normal framework, package, database, and mail tooling may be used to perform the documented steps.
Mark a task complete only when the evaluator performs it successfully under these rules; otherwise
record it as blocked or failed. Record the candidate revision, runtime, database, guard
configuration, permitted guidance and assistance, steps, observed outcomes, errors, and named
limitations. For a blocking failure, record the exact failure and documentation or contract gap, fix
the candidate or state the limitation, then rerun the affected task against the corrected candidate.
An unresolved failure remains a failure; do not count observation alone as success or select new
criteria after seeing the result.

Record package setup time separately from provider credential acquisition, mail-service
configuration, and frontend work. Do not convert an untested duration into a product guarantee.
For the technical fallback, state explicitly that human-participant validation was not performed;
do not claim human usability results, participant task-success measurements, or time guarantees
from the walkthrough. No telemetry or
remote reporting is required. Retain only the local walkthrough record needed to support the
release decision.

## Changelog

This guide records the application-owned integration boundary and the agreed developer-evaluation
protocol. It does not change the package's runtime contract.
