# Inspecting an account's access

Use `authentication.inspectAccountAccess` when an application operator needs a safe account
summary and its credential revision. Account Kit does not authenticate the operator for this
operation. The application must authenticate and authorize the caller first.

This recipe follows the API example's admitted-owner policy. The operator comes from the already
authenticated AdonisJS guard; the target is resolved from the application's canonical account
record. Never take the actor ID from request data. A target ID selects the record, but it does not
grant authority to inspect it.

The controller snippets use the API example's bearer-token strategy: `ACCOUNT_KIT_AUTH_STRATEGY=access_tokens` with the `api` guard.

## Authorize, inspect, and map denial

Mount the route behind the example's `auth()` and `accountAccess()` middleware. Auth first
establishes the caller's identity; account access then checks that caller's current credential and
restriction state. In the controller, check the example's admitted-owner policy before looking up
the target or reading captured state, then pass the authenticated user to the service. The service
checks owner permission again immediately before inspection. The controller bodies below are
composition examples for your application-owned `AdminAccountsController`; the runnable service
and its integration tests are included in the API example:

```ts
import User from '#models/user'
import { inspectAccountForOwner } from '#services/account_access_inspection'
import { isAdmittedOwner } from '#services/account_kit_authorization'

// In a controller after auth and accountAccess middleware have run:
const actor = ctx.auth.use('api').getUserOrFail()
if (!(await isAdmittedOwner(actor.id))) {
  return ctx.response.notFound({ error: 'Account unavailable' })
}
const target = await User.find(ctx.params.userId)
if (!target) return ctx.response.notFound({ error: 'Account unavailable' })
const snapshot = await inspectAccountForOwner(actor, target.id)
if (!snapshot) return ctx.response.notFound({ error: 'Account unavailable' })
ctx.session.put(`accountInspection:${actor.id}:${target.id}`, {
  inspected: true,
  revision: snapshot.revision,
})
return ctx.response.ok(snapshot)
```

```ts
// start/routes.ts
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import AdminAccountsController from '#controllers/admin_accounts_controller'

router
  .get('/api/v1/admin/accounts/:userId', [AdminAccountsController, 'show'])
  .use(middleware.auth())
  .use(middleware.accountAccess())
router
  .post('/api/v1/admin/accounts/:userId/inspection/compare', [AdminAccountsController, 'compare'])
  .use(middleware.auth())
  .use(middleware.accountAccess())
```

The service implementation lives in
[`examples/api/app/services/account_access_inspection.ts`](../../examples/api/app/services/account_access_inspection.ts).
It checks `isAdmittedOwner(actor.id)`, then calls:

```ts
accountKit.authentication.inspectAccountAccess({ userId: targetUserId, requireActive: false })
```

An unauthorized operator is stopped by the application policy before inspection. A missing target
uses the same generic response as an unavailable or restricted target; the controller uses
`User.find` so a framework `NotFound` error cannot produce a different body. Missing and restricted
targets raise the same `AccountAccessDeniedError` at the package boundary, which the service maps to
that response. This example passes `requireActive: false`, so an inactive target is allowed and its
snapshot reports `active: false`. Use `requireActive: true` when inactive accounts must be denied.
Other errors propagate so the application's normal error handler can report operational failures.
The snapshot contains only the safe account projection and revision.

`inspectAccountAccess` is not authentication. Protect any route that exposes it with the app's
normal Auth middleware and apply the application policy on every request. Do not add the inspection
call to an unauthenticated route or treat a successful inspection as proof that the caller is
signed in.

## Compare the revision before a later change

The example stores the returned revision in application-managed authenticated session state under
a key that includes both the authenticated actor and the canonical target ID. The API fixture uses
AdonisJS's encrypted cookie session store by default (`SESSION_DRIVER=cookie`), so its state is
integrity-protected in the cookie rather than stored server-side. If your application stores it in
a database-backed session or another protected store, retain the same actor-and-target binding.
Keep this value out of request bodies, query strings, hidden fields, and other untrusted client
state. A protected cookie can be replayed; the revision check detects account changes but does not
make this context single-use.

Session state only reaches the next request when the client returns the session cookie. A
bearer-token client that sends only `Authorization: Bearer` starts a new session on every request,
so the comparison below always answers "Inspect the account again". For such clients, store the
captured revision server-side instead, for example in an application table or cache entry keyed
by actor and target, and read it back with the same checks.

On the next request, resolve the same target and actor again, authorize again, then compare the
captured revision with a fresh inspection before continuing:

```ts
import User from '#models/user'
import { compareAccountRevisionForOwner } from '#services/account_access_inspection'
import { isAdmittedOwner } from '#services/account_kit_authorization'

const actor = ctx.auth.use('api').getUserOrFail()
if (!(await isAdmittedOwner(actor.id))) {
  return ctx.response.notFound({ error: 'Account unavailable' })
}
const target = await User.find(ctx.params.userId)
if (!target) return ctx.response.notFound({ error: 'Account unavailable' })
const key = `accountInspection:${actor.id}:${target.id}`
const captured = ctx.session.get(key) as { inspected?: unknown; revision?: unknown } | undefined
if (
  !captured ||
  captured.inspected !== true ||
  !Object.hasOwn(captured, 'revision') ||
  (captured.revision !== null && typeof captured.revision !== 'string')
) {
  return ctx.response.conflict({ error: 'Inspect the account again' })
}

const expectedRevision = captured.revision as string | null
const result = await compareAccountRevisionForOwner(actor, target.id, expectedRevision)
if (result.outcome === 'denied') return ctx.response.notFound({ error: 'Account unavailable' })
if (result.outcome === 'changed') {
  return ctx.response.conflict({ error: 'Inspect the account again' })
}
// This handler only compares. If your application also acts, clear state after that action succeeds.
ctx.session.forget(key)
return ctx.response.ok(result.snapshot)
```

For an account whose revision is initially `null`, persist a tagged session value such as
`{ inspected: true, revision: null }`; do not use a missing session value to mean `null`. The
example service's `compareAccountRevisionForOwner` rechecks owner authorization and compares the
stored revision with a fresh snapshot. If the account changed, ask the caller to inspect again.
After a successful comparison, perform the application operation and store a fresh snapshot if the
flow continues. Keep the captured snapshot in authenticated, integrity-protected application state
bound to that actor and target; never accept an arbitrary revision as authority.

The revision comparison detects a change observed before the operation begins. The snapshot does
not lock the account through later application work, so a concurrent change can still happen
between inspection and action. Use an application-owned atomic transaction or conditional write
when the business action itself must be protected from that race. `changeRestriction` covers the
restriction update and revision advance together; its callback must use only the supplied
transaction and may be retried. Keep it read/write database work only.

## Verify the flow

The runnable service and focused integration test are in the API example. The test proves a regular
member cannot inspect, an owner receives and successfully compares the initial `null` revision, a
restriction change advances the revision, a stale revision and revoked owner are denied, a missing
target uses the generic unavailable result, and operational failures propagate. It also verifies
that this `requireActive: false` example returns an inactive account. It exercises the service used
by the recipe rather than a parallel mock flow.

```sh
cd examples/api
pnpm typecheck
pnpm exec node ace test --files=account_access_inspection.spec.ts
```

See [Authentication integration](../authentication.md#inspecting-another-account) for the API
contract and transaction limits.
