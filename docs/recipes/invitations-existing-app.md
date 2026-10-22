# Add invitations to an existing API application

This recipe adds one invitation flow to an existing AdonisJS API application that uses bearer access tokens. It keeps the application's user model, bearer guard, and login endpoint. The application owns the role table, owner policy, invitation routes, and mail delivery. Session-based authorization is out of scope; do not use this bearer ability check unchanged with a session guard.

Install Account Kit using the [README installation instructions](../../README.md#install), then configure it with `node ace configure adonisjs-account-kit`. Follow the shared [existing-application guide](../guides/password-reset-existing-app.md) for the package setup and generated-file review.

## Application-owned authorization

The patch creates `app_user_roles`, keyed by `user_id` and `role`. Assign `owner` only through a trusted, existing provisioning path. Do not add an owner signup option or an admin screen as part of this recipe. The `authorize.invite`, `authorize.manageInvitation`, and `authorize.listInvitations` callbacks query this table. Sending invitations additionally requires the `invitations:create` access-token ability, and the callback rejects the `owner` role. No admission state or admission helper participates in these decisions.

The acceptance callback inserts the invitation's permitted role for the newly created account in the same transaction. The accepted invitee receives `member`; the invitation route cannot assign `owner`.

## File and copy map

| Change                                                  | Source in this recipe | Purpose                                                                                                                                                                                           |
| ------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database/migrations/*_create_app_user_roles.ts`        | Patch                 | Stores application-owned account roles.                                                                                                                                                           |
| `app/services/invitation_authorization.ts`              | Patch                 | Reads owner roles and implements the invitation policy.                                                                                                                                           |
| `app/services/invitation_delivery.ts`                   | Patch                 | Captures invitation links for the acceptance test; replace it with the application's mailer.                                                                                                      |
| `app/controllers/invitations_controller.ts`             | Patch                 | Checks token ability and implements invitation send, inspect, and accept actions.                                                                                                                 |
| `app/middleware/invitation_proof_headers_middleware.ts` | Patch                 | Sets no-store and no-referrer headers for invitation proof paths before request parsing.                                                                                                          |
| `start/kernel.ts`                                       | Patch                 | Registers the invitation proof middleware in the server stack before body parsing.                                                                                                                |
| `start/routes.ts`                                       | Patch                 | Mounts the application's invitation routes beside its existing API routes.                                                                                                                        |
| `config/account_kit.ts`                                 | Patch                 | Enables invitations and validates `fullName` in `registration.mapFields` and assigns it to the Lucid model through `mapRegistrationData`, alongside authorization, delivery, and role assignment. |
| `tests/functional/invitations-existing-app.spec.ts`     | Acceptance spec       | Exercises policy, acceptance, and replay against the scaffold.                                                                                                                                    |

The invitation proof middleware must run in the server stack before the router body parser, so malformed proof submissions retain private-cache and referrer headers. Copy the middleware and its kernel registration with the proof routes. Keep the `owner` role assignment inside the application's trusted provisioning process. Copy the migration, policy, controller, routes, and acceptance callback as a unit. Adapt `registration.mapFields` to validate the profile fields your existing user model requires, then map those fields onto the Lucid model with `mapRegistrationData`; preserve any other application registration fields. Replace only the local delivery callback with the application's mail transport. The acceptance test and local capture service are development evidence, not a delivery provider.

## Failure and recovery evidence

| Case                                              | Expected result                                                   | Evidence                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest sends an invitation                         | `401`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                        |
| Authenticated token lacks `invitations:create`    | `403`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                        |
| Authenticated actor has no `owner` role           | `403`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                        |
| Owner attempts to invite another owner            | `403`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                        |
| Owner sends a member invitation without admission | `201`; a local invitation link is captured                        | `existing app invitations / enforces owner policy and one-time acceptance`                                                                        |
| Invitee accepts                                   | `201`; `member` role is assigned                                  | `existing app invitations / enforces owner policy and one-time acceptance`                                                                        |
| Malformed invitation acceptance body              | `400`; proof headers are set and account/role rows stay identical | `existing app invitations / enforces owner policy and one-time acceptance`                                                                        |
| Invitee replays the accepted link                 | `400`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                        |
| Owner resends or revokes an invitation            | Follow the application policy and verify replacement/revocation   | [invitations over HTTP enforce roles, single acceptance, resend, and revocation](../../examples/api/tests/functional/account_invitations.spec.ts) |

The recipe adds no administration UI. The app owner provisions the first owner using an existing trusted path.

## Clean application check

**22 October 2026 — P6 passed.** The harness created the pinned official API starter, confirmed its original login and protected profile worked before installing Account Kit, applied the recipe patch to the configured application, and ran the committed acceptance spec.

| Field                               | Recorded evidence                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recipe source revision              | `c2708c3dbc881b6a28bf3fcd636a48c0642b40e0` (clean working tree)                                                                                                                                                    |
| Candidate archive                   | `adonisjs-account-kit-0.1.1.tgz`; source `402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf`; SHA-256 `fd01e7fcb561f04934c5abb58701271515e9f55afeca1a8465aa913896669227`                                                    |
| P1 creator and starter              | `create-adonisjs` `3.4.0`; API starter `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`                                                                                                                                  |
| P1 baseline / configured checkpoint | `fbaee98745c65b39107972faaa66d69b31a84b7f` / `76a5b65afe9a7840c29ae1d000911785a4490d99`                                                                                                                            |
| P1 starter login                    | `pnpm test --files=recipe_starter_login.spec.ts`: `original starter login reaches its protected profile`, 1/1 passed before Account Kit was installed                                                              |
| Starter lockfile SHA-256            | `8e460c40eb5f4434146cc653c565892d2581d4a29e8f1f1756a4bb500f1f3d0d`                                                                                                                                                 |
| Runtime and package manager         | Node `24.21.0`; pnpm `11.23.0`                                                                                                                                                                                     |
| Installed framework packages        | Core `7.6.0`; Auth `10.1.0`; Lucid `22.4.2`; Limiter `3.0.1`; Vine `4.4.0`; better-sqlite3 `13.0.3`                                                                                                                |
| Database                            | Local SQLite `3.53.4`; each starter used its own `tmp/db.sqlite3`                                                                                                                                                  |
| Notification mode                   | Local in-process invitation-link capture; no recipient delivery                                                                                                                                                    |
| P6 acceptance                       | `existing app invitations / enforces owner policy and one-time acceptance`, 1/1 passed, including malformed-body proof headers, owner-without-admission send and acceptance, role assignment, and replay rejection |
| P6 repeatability replay             | The retained scaffold reran `pnpm test --files=invitations-existing-app.spec.ts` with database truncation before and after the test; 1/1 passed (125.5 ms test, 161 ms total)                                      |
| Archive integrity                   | The supplied archive SHA-256 matched the recorded digest after the P6 run                                                                                                                                          |

The starter was created with:

```sh
pnpm create adonisjs@3.4.0 <directory> \
  --kit=github:adonisjs/starter-kits/api#46d235932e3eb6472a16b740fa0b47b5f69fc6fc \
  --pkg=pnpm
```

The creator did not initialize Git. The baseline was recorded with `git init`, `git add -A`, and `git commit -m starter`. The supplied-archive acceptance run used:

```sh
pnpm test:recipe -- --recipe=invitations-existing-app \
  --candidate-tarball=<retained-run-directory>/candidate/adonisjs-account-kit-0.1.1.tgz \
  --candidate-revision=402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf
```

The harness then ran `pnpm test --files=invitations-existing-app.spec.ts` in the retained scaffold. A repeatability replay ran the same command against that scaffold after truncating its test database before and after the spec; it passed 1/1. The result covers SQLite and local callback capture only; it does not establish email delivery, PostgreSQL behavior, or browser coverage.
