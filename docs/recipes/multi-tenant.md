# Multi-tenant applications

Account Kit has global accounts: one user row per email address. It has no tenant concept. Keep
workspace membership and invitation policy in the application. This example uses a `memberships`
table with `user_id`, `workspace_id`, and `role` columns. Invitations carry the workspace in
`scope` and the membership role in `role`; the package stores both and interprets neither.

## Configure workspace invitation policy

Put these helpers in `app/services/workspace_invitations.ts`. Workspace IDs here are positive
integer keys. Validate the whole scope: workspace `1` must never match workspace `10`.

```ts
// app/services/workspace_invitations.ts
import db from '@adonisjs/lucid/services/db'
import type { Trx } from '@kevinjohn/adonisjs-account-kit'

export function workspaceId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export function memberRole(value: unknown): 'member' | 'admin' | null {
  return value === 'member' || value === 'admin' ? value : null
}

export async function isWorkspaceAdmin(userId: number | string, id: number, trx?: Trx) {
  const query = trx ? trx.from('memberships') : db.from('memberships')
  return Boolean(
    await query.where('user_id', userId).where('workspace_id', id).where('role', 'admin').first()
  )
}
```

Use the same parsers and membership check for creation, listing and management. Add the import at
the top of `config/account_kit.ts` and place these properties in its existing `defineConfig`
options; keep its other required options. Every callback receives the scope: `invite` and
`listInvitations` in `context.scope`, `manageInvitation` and `onInvitationAccepted` on the
invitation.

```ts
// At the top of config/account_kit.ts:
import { isWorkspaceAdmin, memberRole, workspaceId } from '#services/workspace_invitations'

// Inside defineConfig({ ... }):
authorize: {
  invite: async (actor, role, context) => {
    const workspace = workspaceId(context?.scope)
    return (
      workspace !== null &&
      memberRole(role) !== null &&
      isWorkspaceAdmin(actor.id, workspace, context?.trx)
    )
  },
  manageInvitation: async (actor, invitation, context) => {
    const workspace = workspaceId(invitation.scope)
    return workspace !== null && isWorkspaceAdmin(actor.id, workspace, context?.trx)
  },
  listInvitations: async (actor, context) => {
    const workspace = workspaceId(context?.scope)
    return workspace !== null && isWorkspaceAdmin(actor.id, workspace, context?.trx)
  },
},
onInvitationAccepted: async (user, invitation, trx) => {
  const workspace = workspaceId(invitation.scope)
  const role = memberRole(invitation.role)
  if (workspace === null || role === null) throw new Error('Invalid workspace invitation')
  await trx.table('memberships').insert({ user_id: user.id, workspace_id: workspace, role })
},
```

The managed `POST /api/v1/account/invitations` takes `{ email, role, scope }`; `invite` checks the
target workspace before creation and again inside the transaction. Managed resend and revoke
check `manageInvitation` against the stored scope. `listInvitations` denies a request without a
scope, so `GET /api/v1/account/invitations?scope=1` returns one workspace's pending invitations
and an unscoped list is refused. Acceptance applies the stored scope and role without rechecking
the inviter's current authority; if that authority changes, revoke the outstanding invitation.

One address can hold one pending invitation per workspace. When the person accepts any of them,
every pending invitation for the address is applied in the same transaction, in ascending `scope`
order, so `onInvitationAccepted` inserts one membership per workspace.

## Limits to plan around

- **Invitations are for new accounts.** Inviting an existing account throws
  `EmailAlreadyRegisteredError`. Add existing users to a workspace with your own flow.
- **Rate limits are shared.** Use one `limiterSecret` and `limiterNamespace` per deployment,
  not per workspace.

## Separate databases per workspace

`AccountKit` can be constructed with `new AccountKit({ config, db, limiter })`, so a
database-per-workspace app can build one instance per connection. Each database needs the
package migrations. This setup is not covered by the package tests.
