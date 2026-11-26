# Admission

Admission decides whether a signed-in, verified account may use the application. It is optional
and separate from [registration](registration.md), which decides who may create an account.

An application can require any combination of three things before a person reaches protected
data:

- **domain**: the confirmed address is on an allowed domain;
- **invitation**: the account has invitation evidence;
- **approval**: an approver approved the account.

Every requirement you configure must be met. None is on by default. Account Kit stores the state
and evaluates it; the application decides who may approve, and owns every screen and every word.
There are no roles, no admin pages and no managed admission routes.

Admission lives in its own entry point, `@kevinjohn/adonisjs-account-kit/admission`. The rest of the package
never imports it, so an application that does not install it is unchanged.

## Configuration

`config/admission.ts`:

```ts
import { defineConfig } from '@kevinjohn/adonisjs-account-kit/admission'

export default defineConfig({
  domain: { allowed: ['example.com'], includeSubdomains: false }, // omit to disable
  invitation: { required: true }, // omit to disable
  approval: {
    // omit to disable
    required: true,
    authorize: {
      decide: async (actor, subject, context) => false, // may actor approve, reject or revoke subject
      list: async (actor, context) => false, // may actor list records; runs with no context.trx
    },
  },
  onAdmissionEvent: async (event) => {}, // optional, after commit, ids only
})
```

`defineConfig` fails at boot when:

- none of `domain`, `invitation` and `approval` is present. To turn admission off, do not install
  the module;
- `domain.allowed` is empty, or an entry is not a lowercase ASCII domain of at least two labels
  (no `@`, no `*`, no leading or trailing dot, labels of at most 63 characters, at most 253 in
  all);
- `invitation` or `approval` lacks `required: true`;
- `approval.authorize.decide` or `approval.authorize.list` is not a function;
- `onAdmissionEvent` is present and not a function.

`approval.authorize` and `onAdmissionEvent` may come from the `account_admission.callbacks`
registry instead, as `approvalAuthorize` and `onAdmissionEvent`; see
[registering callbacks from a provider](../../README.md#registering-callbacks-from-a-provider).
The `approval.authorize` checks then run when the admission service is first resolved.

Register the provider in `adonisrc.ts`:

```ts
providers: [
  // ...
  () => import('@kevinjohn/adonisjs-account-kit/admission/provider'),
]
```

It binds `AccountAdmission` as a container singleton, with the alias `account_admission`, built from
`config/account_kit.ts` and `config/admission.ts`. Resolve it with
`app.container.make(AccountAdmission)`.

Wrap two callbacks in `config/account_kit.ts`:

```ts
import {
  withAdmissionCleanup,
  withInvitationEvidence,
} from '@kevinjohn/adonisjs-account-kit/admission'

export default defineConfig({
  // ...
  onInvitationAccepted: withInvitationEvidence(async (user, invitation, trx) => {
    // grant invitation.role through trx, as before
  }),
  onAccountDeletingTransaction: withAdmissionCleanup(),
})
```

- `withInvitationEvidence(next?)` records invitation evidence through `trx`, then runs `next`. The
  evidence and the new account commit together; a throwing `next` rolls back both. It records
  evidence whether or not the `invitation` requirement is on, so the `account_admissions` table
  must exist whenever the wrapper is installed. Evidence already on the account is kept.
- `withAdmissionCleanup(next?)` deletes the account's admission row and clears it as the approver
  of other rows, then runs `next`. It does not rely on foreign-key cascades.

The `account_admissions` table comes from the `create_account_admissions` migration stub, rendered
with the same `--users-table` and `--user-id-type` choices as the rest of the package.

## How it works

`AccountAdmission` reads the user row and the admission row on every call. Nothing is cached, and
every instance sharing the database sees a change on its next request.

| Requirement | Met when                                                                         |
| ----------- | -------------------------------------------------------------------------------- |
| domain      | the address is confirmed and its domain equals an allowed entry, or is under one |
| invitation  | invitation evidence is recorded                                                  |
| approval    | the approval status is `approved`                                                |

- **domain.** A confirmed address has `emailVerifiedAt` set and is not only waiting for
  confirmation. An unconfirmed address reports `reason: 'unverified'`; any other mismatch reports
  `reason: 'not_allowed'`. A match is equality with an entry, or, with `includeSubdomains`,
  ending in `.` plus the entry: `example.com.evil` and `evil-example.com` never match
  `example.com`. A malformed stored address fails closed. There is no IDN or punycode
  conversion, so a stored Unicode domain never matches. A pending email change does not count
  until it is confirmed; after confirming an address outside the list, the person loses admission
  on the next gated request.
- **invitation.** Evidence is recorded only by `withInvitationEvidence`. The recorded address is
  history and is not compared again.
- **approval.** With no decision the status is `pending`, and `requested` says whether the person
  asked. `rejected` and `revoked` stay until an approval: signing in, verifying, social sign-in,
  email change and later invitations never change them.

Admission is not restriction and not activation:

- a restricted account (`authentication.canAccess` is false) cannot sign in at all: 401;
- an unconfirmed account is refused by `requireActive`: 403 `E_ACCOUNT_KIT_UNVERIFIED_EMAIL`;
- an account that is not admitted can sign in and use the limited surface, and is refused by the
  admission gate: 403 `E_ACCOUNT_KIT_ADMISSION_REQUIRED`.

Rejecting or revoking does not end sessions. The decision is read on every gated request, for both
guard strategies. To also sign the person out, call `kit.authentication.changeRestriction`.

### Service

| Method                                                            | Does                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current(input)`                                                  | Checks the credential like `kit.authentication.current`, then evaluates admission, in one transaction. Returns `{ account, decision }`.                             |
| `require(input, { active? })`                                     | Like `current`; throws `E_ACCOUNT_KIT_UNVERIFIED_EMAIL` for an unconfirmed account unless `active: false`, then `E_ACCOUNT_KIT_ADMISSION_REQUIRED` unless admitted. |
| `decide(user, trx)`                                               | Evaluates the requirements for a user row inside your transaction.                                                                                                  |
| `isAdmitted(userId, trx?)`                                        | True when admitted; false for an unknown user. For `authorize` and `exportAccountData` callbacks.                                                                   |
| `record(userId, trx?)`                                            | The user's admission record, including `invitation.role`; null for an unknown user or one with no admission row. Pass your `trx` to see its writes.                 |
| `request(input)`                                                  | The signed-in person asks for approval, so the pending list shows them. Idempotent; refuses an unconfirmed account.                                                 |
| `approve`, `reject`, `revoke`                                     | An approver's decision: `{ actorId, userId }`. See [decisions](#decisions).                                                                                         |
| `list({ actorId, status?, cursor?, limit? })`                     | Admission records, oldest first, 1 to 100 a page (default 25), after `authorize.list` returns `true`.                                                               |
| `operator.approve`, `operator.revoke`, `operator.grantInvitation` | Shell-trusted changes by `{ email }` for Ace commands: no actor, no `authorize`. Never expose them to a request.                                                    |
| `eligibleDomain(email)`                                           | Whether an address would meet the domain requirement once confirmed. True when the requirement is off; false for a malformed one.                                   |

`input` is the same `CurrentAccountInput` your guard returns: a credential check always comes
first, so an expired session fails with `E_ACCOUNT_KIT_INVALID_SESSION` before admission is evaluated.

`list` returns `{ items, nextCursor }`. Pass a returned cursor as `cursor` for the next page.
A null `nextCursor` marks the final page. The existing `approval.authorize.list` callback
must return exactly `true` to allow listing.

The decision names only the enabled requirements:

```ts
{
  admitted: false,
  requirements: {
    domain: { met: true },
    invitation: { met: true },
    approval: { met: false, status: 'pending', requested: true },
  },
}
```

### Gating routes

For application-owned routes, `AdmissionMiddleware` checks the selected guard, the credential and
admission before the route runs:

```ts
import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
import AdmissionMiddleware from '@kevinjohn/adonisjs-account-kit/middleware/admission'

const admitted = new AdmissionMiddleware({
  admission: () => app.container.make(AccountAdmission),
  guard, // the createManagedGuard(...) adapter the managed routes use
})

router.get('/reports', [ReportsController, 'index']).use(admitted.handle.bind(admitted))
```

Pass `active: false` to skip the activation check. Without `createManagedGuard`, call
`admission.require(input)` from your own middleware, as you would `requireActive`. The managed
routes cannot carry this middleware; they stay the limited surface.

After the middleware, `ctx.auth.user`, `ctx.auth.isAuthenticated` and `ctx.auth.getUserOrFail()`
answer for the selected guard, as they do after `middleware.auth({ guards: [name] })`, so the
default Bouncer initialiser and application code see the signed-in user without a second
`auth` middleware. `ManagedAccountMiddleware` does the same.

### Errors

Both errors extend `E_ACCOUNT_KIT` and are exported from `@kevinjohn/adonisjs-account-kit/admission` only.
`accountErrorResponse` maps them like any other package error.

| Error                              | Code                               | Status | When                                                                             |
| ---------------------------------- | ---------------------------------- | -----: | -------------------------------------------------------------------------------- |
| `E_ACCOUNT_KIT_ADMISSION_REQUIRED` | `E_ACCOUNT_KIT_ADMISSION_REQUIRED` |    403 | `require` refused a person who is not admitted. `decision` says what is missing. |
| `E_ACCOUNT_KIT_ADMISSION_DECISION` | `E_ACCOUNT_KIT_ADMISSION_DECISION` |    409 | An approve, reject or revoke the current approval state does not allow.          |

`accountErrorResponse` returns one entry under `errors`: `{ code, message }`, or
`{ code, title }` when its `accept` option asks for JSON:API. Add `error.decision` to the 403 body in
your exception handler so the application can say what is missing, inside whatever error envelope
it already negotiates; the example puts it at the top level of a JSON body and in `meta` of a
JSON:API body. The package sends no notification of any kind.

## Decisions

`approve`, `reject` and `revoke` take `{ actorId, userId }` and run in one transaction that locks
the actor and the subject in id order, so two approvers deciding on each other cannot deadlock.
They are refused with:

- `E_ACCOUNT_KIT_USER_NOT_FOUND` for an unknown subject, `E_ACCOUNT_KIT_INVALID_INPUT('Unknown actor')` for an unknown
  actor;
- `E_ACCOUNT_KIT_AUTHORIZATION` when the actor is the subject, when the actor is not admitted, or when
  `authorize.decide(actor, subject, { trx })` returns anything but `true`;
- `E_ACCOUNT_KIT_ADMISSION_DECISION` for a transition the table does not allow;
- `E_ACCOUNT_KIT_CAPABILITY_DISABLED` when `approval` is not configured. The same applies to `request`,
  `list` and the operator decisions.

| From        | approve  | reject   | revoke  |
| ----------- | -------- | -------- | ------- |
| no decision | approved | rejected | refused |
| approved    | refused  | refused  | revoked |
| rejected    | approved | refused  | refused |
| revoked     | approved | refused  | refused |

Repeating a successful call is refused on purpose; read `list` for the current state. The
record stores who decided and when; an operator decision stores no actor.

After commit, `onAdmissionEvent` receives `admission.requested`, `admission.approved`,
`admission.rejected`, `admission.revoked` or `admission.invitation_granted`, with ids and an
`operationId` only. A failing hook surfaces as `E_ACCOUNT_KIT_POST_COMMIT`: the change is saved, so do not
repeat it. Account Kit sends no email about admission; use the hook to notify people.
`admission.requested` is sent only for a person with no decision yet. A bootstrap approval sends no
event, either when it is issued or when its invitation creates the account.

`list` filters by `status`: `pending` is a person who asked and has no decision; `approved`,
`rejected` and `revoked` are the stored decisions; omitted lists every record. The cursor is
opaque and checked; a forged one is `E_ACCOUNT_KIT_INVALID_INPUT`.

## Commands

| Command                                                                                  | Does                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `account-kit:admission:install [--users-table] [--user-id-type] [--migration-directory]` | Writes the migration and `config/admission.ts` (never overwriting), registers the provider and the command loader, and prints the manual steps. |
| `account-kit:admission:approve <email>`                                                  | Operator approval, through the same transitions. For the first administrator and for recovery.                                                  |
| `account-kit:admission:revoke <email>`                                                   | Operator revocation.                                                                                                                            |
| `account-kit:admission:grant-invitation <email> [--role]`                                | Records operator invitation evidence for an existing account; refused when evidence exists. `--role` is stored only; it grants nothing.         |
| `account-kit:admission:bootstrap <email> --role <role>`                                  | Issues an operator invitation, prints its link and writes an approval for the account it creates. `--cancel` deletes that approval instead.     |

The runtime commands write one JSON result line to stdout when an operation returns a result.
A thrown runtime failure leaves the original error on Ace's `command.error`, reports one safe
diagnostic with a code on stderr and exits with code 1.

## Turning a requirement on later

A requirement applies to every existing account on its next gated request:

| Enabled later | Existing accounts              | Path back                                                                           |
| ------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| domain        | outside the list: not admitted | none by design; change the list                                                     |
| invitation    | no evidence: not admitted      | `account-kit:admission:grant-invitation <email>`, or a migration writing the rows   |
| approval      | no decision: pending           | `account-kit:admission:approve <email>` for the first administrator, then approvers |

Disabling a requirement leaves its stored columns untouched; turning it on again reads them
again, so an earlier rejection still stands. Deleting an account removes its row, so a person who
deletes and registers again starts pending.

## First administrator

Account Kit bootstraps admission state only; the application establishes authority its own way.
For example:

1. `node ace account-kit:invite admin@example.com --role owner --print`, then accept the link.
   The application's `onInvitationAccepted` assigns the role and the wrapper records the
   evidence.
2. Confirm the address is on an allowed domain.
3. `node ace account-kit:admission:approve admin@example.com`.

That account is now admitted, so it can approve others. A locked-out administrator is recovered
with the same approve command. There is no "first user is admin" shortcut.

`node ace account-kit:admission:bootstrap admin@example.com --role owner` does steps 1 and 3 in
one command, before the account exists:

- It issues an operator invitation, prints the link like `account-kit:invite --print`, and writes
  an approval for that address with no account yet (`user_id` null, `bootstrap_email` set).
- When that invitation is accepted, or matched when the address first signs in,
  `withInvitationEvidence` attaches the approval to the new account. The account lands admitted:
  evidence `source: 'invitation'` and approval `actorId: null`.
- Only the invitation the bootstrap issued attaches it: the approval records that invitation's id.
  Another invitation to the same address does not, including one whose inviter was deleted.
- The invitation and its bound approval commit together. If either write fails, the previous
  invitation and approval remain usable. The link is printed only after commit and follow-ups;
  a bootstrap replaced or cancelled during those follow-ups returns no link.
- A second bootstrap for the address replaces the approval and the invitation. `--cancel` deletes
  the approval only; it does not revoke the invitation. The invitation can still be accepted and
  invoke the application's `onInvitationAccepted` callback, including its role or membership
  writes. To prevent both effects, revoke the invitation separately with
  `kit.invitations.revoke({ actorId, invitationId })` (see the [invitation service operations](usage.md#capabilities))
  or the [managed HTTP `account.invitation.revoke` route](managed-http.md#how-it-works), when the
  actor is authorised by the application.
- `list` and decisions never show an approval that waits for its account.
- Nothing prunes these rows. Cancel waiting approval and revoke its invitation separately when you
  want to remove both outcomes.

The address must still be on an allowed domain when that requirement is on. The two-command path
above keeps working.

## Deployment

- Run the migration before deploying code that installs the provider or the wrappers.
- During a rolling deploy an old instance has no gate and a new one has it, so protected data is
  gated everywhere only once every instance runs the new code. Changing `domain.allowed` is a
  config deploy with the same window.
- Rolling back the code keeps the table and its rows. Dropping the table loses evidence and
  decisions and is not a supported rollback.

## Example application

`examples/api` runs admission with invitation and approval on, and domain on when
`ACCOUNT_KIT_ADMISSION_DOMAINS` (comma-separated) is set:

The [API example README](../../examples/api/README.md#admission-routes) maps its status, request,
owner-list, and decision endpoints to their controller, validator, route gates, and application
authorisation policy.

| File                                              | Holds                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `config/admission.ts`                             | The requirements; owners decide and list                                                                                       |
| `config/account_kit.ts`                           | Invitation evidence and cleanup hooks. Invitation authorisation and export callbacks resolve admission lazily                  |
| `app/services/account_kit_authorization.ts`       | `isAdmittedOwner` for invitation policy and `admissionAuthorize` for list and decision policy                                  |
| `app/middleware/admitted_account_middleware.ts`   | Admission gate with injected `AccountAdmission`                                                                                |
| `app/controllers/admissions_controller.ts`        | Status, request, list and decisions with injected `AccountAdmission` and controller input validation                           |
| `app/exceptions/handler.ts`                       | Adds `decision` to the 403 body (`meta.decision` for JSON:API)                                                                 |
| `start/routes.ts`                                 | `GET /account/admission` and `POST /account/admission/request` (limited); the list and decisions and `GET /reports` (admitted) |
| `examples/api/tests/functional/admission.spec.ts` | The flows above, for both guard strategies                                                                                     |

Callbacks resolve admission when called, for the reason given in
[registering callbacks from a provider](../../README.md#registering-callbacks-from-a-provider).

## Files delta

`account-kit:admission:install` adds:

- `config/admission.ts`, from the stub, when it does not exist;
- `<timestamp>_account_kit_admission_create_account_admissions.ts` in the primary Lucid
  connection's migration directory, when no admission migration already exists;
- the provider `@kevinjohn/adonisjs-account-kit/admission/provider` and the command loader
  `@kevinjohn/adonisjs-account-kit/admission/commands` in `adonisrc.ts`.

The installer follows the [setup migration path rules](setup.md), including the application
default when the primary connection has no paths. It allocates the new migration after existing
timestamped migrations, including the application's users-table migration. If the configured path
is dynamic, or the connection lists several paths, pass `--migration-directory` with the
application-relative directory to use.

## Manual steps

1. Set the requirements and `approval.authorize` in `config/admission.ts`.
2. Wrap `onInvitationAccepted` with `withInvitationEvidence` and set `onAccountDeletingTransaction:
withAdmissionCleanup()` in `config/account_kit.ts`.
3. Run `node ace migration:run`.
4. Gate the routes that serve application data, and keep a status route reachable.
5. Make your `authorize` callbacks for invitations and data export check `isAdmitted`, since
   managed routes accept any valid credential.
6. Admit the [first administrator](#first-administrator).

## Changelog

Admission arrived in the 0.1.0 section of the [changelog](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/CHANGELOG.md):
the module, decisions and commands, and the example application.
