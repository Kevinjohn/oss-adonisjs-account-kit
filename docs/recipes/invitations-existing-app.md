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

| Case                                              | Expected result                                                   | Evidence                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest sends an invitation                         | `401`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                      |
| Authenticated token lacks `invitations:create`    | `403`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                      |
| Authenticated actor has no `owner` role           | `403`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                      |
| Owner attempts to invite another owner            | `403`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                      |
| Owner sends a member invitation without admission | `201`; a local invitation link is captured                        | `existing app invitations / enforces owner policy and one-time acceptance`                                                                      |
| Invitee accepts                                   | `201`; `member` role is assigned                                  | `existing app invitations / enforces owner policy and one-time acceptance`                                                                      |
| Malformed invitation acceptance body              | `400`; proof headers are set and account/role rows stay identical | `existing app invitations / enforces owner policy and one-time acceptance`                                                                      |
| Invitee replays the accepted link                 | `400`; account and role rows stay identical                       | `existing app invitations / enforces owner policy and one-time acceptance`                                                                      |
| Owner resends or revokes an invitation            | Follow the application policy and verify replacement/revocation   | `invitations over HTTP enforce roles, single acceptance, resend, and revocation` in `examples/api/tests/functional/account_invitations.spec.ts` |

The recipe adds no administration UI. The app owner provisions the first owner using an existing trusted path.

## Clean application check

P6 acceptance on the supplied candidate is pending. Run:

```sh
pnpm test:recipe -- --recipe=invitations-existing-app --candidate-tarball=<archive> --candidate-revision=<source-revision>
```

The P6 evidence record will replace this note after the pinned API starter applies the committed patch and runs the named acceptance spec. The check is limited to SQLite and local in-process invitation-link capture; it does not deliver email or test PostgreSQL.
