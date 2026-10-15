# Application-owned integration

Use this guide when the application owns its HTTP routes and controllers and calls Account Kit's
public account operations. Account Kit does not register these routes, choose the application's
response format, or replace its authentication guard. The [API consumer example](../examples/api/README.md)
shows a complete AdonisJS application; this guide explains the boundaries to preserve when adapting
it.

## Configuration

Configure the user adapter, enabled capabilities, authorization and notification callbacks in
`config/account_kit.ts` with `defineConfig`. Keep environment-specific secrets in the application's
environment configuration. The API example uses a lazy Lucid user adapter and explicitly maps
validated registration data; it does not spread request fields onto the user model. See the
[example configuration](../examples/api/config/account_kit.ts) and [service configuration guide](usage.md#configuration)
for the supported options and defaults.

Account Kit is available from the AdonisJS container after its provider is configured:

```ts
import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'

const kit = await app.container.make(AccountKit)
```

Keep each route's middleware and capability selection explicit. Apply the selected authentication
integration before loading an actor, and apply verified-account or application authorization checks
where the operation requires them. The [authentication guide](authentication.md) documents the
session and access-token boundaries, including CSRF and credential revocation.

## How it works

### Validate requests before calling account operations

Use AdonisJS validators to normalize and validate request bodies, query values, and route
parameters. Pass only the validated fields required by the operation. For authenticated actions,
derive `actorId` from the authenticated user; never accept a caller-supplied identifier as proof of
authority. The example's [validators](../examples/api/app/validators/account_kit.ts) and
[application-owned controller](../examples/api/app/controllers/account_kit_controller.ts) show this
boundary.

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

The example's [password-change action](../examples/api/app/controllers/account_kit_controller.ts)
uses this service contract.

### Keep HTTP policy in the application

Controllers choose status codes, response bodies, and route middleware. Use the central exception
handler to translate package errors through `accountErrorResponse`, or map errors to the
application's established response format. Do not return internal causes or package diagnostics.
Preserve operation-specific disclosure rules: a password-reset request returns the same
acknowledgement for known and unknown addresses, including when post-commit delivery fails. See
[HTTP and error handling](usage.md#http-and-error-handling) for the current error contract.

### Let package operations own account writes

Call the public operation for password resets, email verification, invitations, and email or
password changes. Keep related application writes in the package's transaction callbacks and use
the provided `trx`. Do not put package writes inside an application-wide transaction or call
external services from transaction callbacks. Application-owned registration and login routes
remain responsible for their model creation and selected guard integration; follow the
[session integration](authentication.md#how-it-works) and [API example](../examples/api/start/routes.ts)
for the current contract.

For post-commit notifications that must survive a process failure, persist an outbox record in the
transaction callback and deliver it from an application worker. A callback failure after commit does
not roll the account change back. The example's [notification callbacks](../examples/api/app/services/account_kit_notifications.ts)
and [outbox worker](../examples/api/app/services/account_kit_outbox.ts) are a fixture, not a complete
production dispatcher: their in-memory receiver and sequential worker do not provide durable
idempotency or concurrent-claim guarantees.

### Replace one route at a time

When an application needs different policy or response behavior, keep that route application-owned
and call the relevant public operation from its controller. Retain the package's account rules and
the same authorization, validation, and disclosure checks. Other routes can continue using the
application's existing integration. The [service usage guide](usage.md) lists the public operations
and [compatibility guide](compatibility.md) states the supported adapter and database boundary.

## Files delta

The application owns its routes, controllers, validators, exception handler, authentication
middleware, user model, and notification delivery. Configure adds the package provider, the
`config/account_kit.ts` file, and the package migrations when those files are absent. The
[API consumer fixture](../examples/api) shows these files together. No managed HTTP routes are
activated by resolving the service API.

## Manual steps

1. Configure the package and review the generated config and migrations before applying them.
2. Select the existing authentication guard and install its required session or access-token,
   CSRF, limiter, and persistence dependencies.
3. Define request validators, middleware, response schemas, and authorization policy in the
   application. Derive actor identity from the selected guard and derive limiter client identity
   only after trusted proxies are configured.
4. Map every account operation to the public service call and its documented callback. Keep
   database changes in the supplied transaction and move durable delivery to an application-owned
   worker when required.
5. Exercise the application's routes against the installed package and the configured database.
   Keep the application's frontend and deployment configuration in its own scope.

### Developer evaluation protocol

Use M1 and M2 walkthrough findings to refine the onboarding targets before the final managed-backend
evaluation. Keep the task set and pass rule below fixed before that evaluation so its criteria are
not selected retrospectively.

The preferred final evaluation uses three to five developers, including at least one developer new
to AdonisJS and one familiar with it. Participants may use the published documentation only. The
product owner is accountable for the evaluation and success criteria; the technical maintainer
validates that the tasks are feasible against the supported application.

If those participants are unavailable for this run, the product owner has approved a documented
technical walkthrough as the fallback. It uses the same four tasks:

1. Configure a supported conventional AdonisJS application using the published documentation.
2. Explain the setup changes and the responsibilities that remain with the application.
3. Exercise the enabled account lifecycle through the application's routes.
4. Replace one endpoint while preserving the other enabled routes.

Each task succeeds only when it is completed using published documentation, without undocumented
application code or undocumented assistance. Record the candidate revision, runtime, database,
guard configuration, steps, observed outcomes, errors, and remaining limitations. When a task
blocks, record the exact failure and the documentation or contract gap; fix the candidate or record
an explicit limitation, then rerun the affected task against the corrected candidate. Do not count
observation alone as success.

Record package setup time separately from provider credential acquisition, mail-service
configuration, and frontend work. Do not convert an untested duration into a product guarantee.
For the technical fallback, state explicitly that human-participant validation was not performed;
do not report human usability outcomes or participant task-success measurements. No telemetry or
remote reporting is required. Retain only the local walkthrough record needed to support the
release decision.

## Changelog

This guide records the application-owned integration boundary and the agreed developer-evaluation
protocol. It does not change the package's runtime contract.
