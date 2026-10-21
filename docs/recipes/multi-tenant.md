# Multi-tenant applications

Account Kit has global accounts: one user row per email address. It has no tenant concept. Keep
workspace membership and invitation policy in the application. This example uses a `memberships`
table with `user_id`, `workspace_id`, and `role` columns. Invitation roles are exactly
`<workspace id>:member` or `<workspace id>:admin`.

## Configure workspace invitation policy

Put these helpers in `app/services/workspace_invitations.ts`. Workspace IDs here are positive
integer keys. Validate the entire role: workspace `1` must never match workspace `10`.

```ts
// app/services/workspace_invitations.ts
import db from '@adonisjs/lucid/services/db'
import type { Trx } from 'adonisjs-account-kit'

export function workspaceId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export function invitationRole(value: unknown) {
  if (typeof value !== 'string') return null
  const match = /^([1-9]\d*):(member|admin)$/.exec(value)
  if (!match) return null
  const id = workspaceId(match[1])
  return id === null ? null : { workspaceId: id, memberRole: match[2] as 'member' | 'admin' }
}

export async function isWorkspaceAdmin(userId: number | string, id: number, trx?: Trx) {
  const query = trx ? trx.from('memberships') : db.from('memberships')
  return Boolean(
    await query.where('user_id', userId).where('workspace_id', id).where('role', 'admin').first()
  )
}
```

Use the same parser and membership check for creation and management. Add the import at the top of
`config/account_kit.ts` and place these properties in its existing `defineConfig` options; keep
its other required options. `listInvitations` is denied because the application replaces that route below.
Granting package list permission would **not** add a workspace predicate to its query.

```ts
// At the top of config/account_kit.ts:
import { invitationRole, isWorkspaceAdmin } from '#services/workspace_invitations'

// Inside defineConfig({ ... }):
authorize: {
  invite: async (actor, role, context) => {
    const selected = invitationRole(role)
    return selected !== null && isWorkspaceAdmin(actor.id, selected.workspaceId, context?.trx)
  },
  manageInvitation: async (actor, invitation, context) => {
    const selected = invitationRole(invitation.role)
    return selected !== null && isWorkspaceAdmin(actor.id, selected.workspaceId, context?.trx)
  },
  listInvitations: async () => false,
},
onInvitationAccepted: async (user, invitation, trx) => {
  const selected = invitationRole(invitation.role)
  if (!selected) throw new Error('Invalid workspace invitation role')
  await trx.table('memberships').insert({
    user_id: user.id,
    workspace_id: selected.workspaceId,
    role: selected.memberRole,
  })
},
```

The managed `POST /api/v1/account/invitations` can send a role such as `1:member`; `invite`
checks its target workspace before creation. Managed resend and revoke check
`manageInvitation` against the stored role. Resend also checks `invite` again. Keep these
callbacks aligned with changes to your membership policy. Acceptance applies the stored role
without rechecking the inviter's current authority; if that authority changes, revoke the
outstanding invitation or add an application acceptance policy.

## List one workspace on the server

Add a controller that derives the actor from the selected authenticated guard. The validated
route ID selects one scope. Apply its exact role predicate to both count and page queries
_before_ pagination or response construction. Lucid binds query values as parameters.

```ts
// app/controllers/workspace_invitations_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { isWorkspaceAdmin, workspaceId } from '#services/workspace_invitations'

export default class WorkspaceInvitationsController {
  async index({ auth, params, request, response }: HttpContext) {
    const selected = workspaceId(params.workspaceId)
    if (selected === null) return response.badRequest({ error: 'Invalid workspace' })

    const actor = auth.use('api').getUserOrFail()
    if (!(await isWorkspaceAdmin(actor.id, selected))) return response.forbidden()

    const rawPage = request.input('page', '1')
    const rawLimit = request.input('limit', '20')
    const validNumber = (value: unknown) =>
      typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
    if (!validNumber(rawPage) || !validNumber(rawLimit))
      return response.badRequest({ error: 'Invalid pagination' })
    const page = Number(rawPage)
    const limit = Number(rawLimit)
    if (limit > 100 || (page - 1) * limit > Number.MAX_SAFE_INTEGER - limit)
      return response.badRequest({ error: 'Invalid pagination' })

    const now = DateTime.utc()
    const cutoff =
      db.connection().dialect.name === 'mysql'
        ? now.toFormat('yyyy-MM-dd HH:mm:ss.SSS')
        : now.toISO()!
    const scoped = () =>
      db
        .from('account_invitations')
        .whereIn('role', [`${selected}:member`, `${selected}:admin`])
        .where('expires_at', '>', cutoff)

    const [{ total }, rows] = await Promise.all([
      scoped().count('* as total').firstOrFail(),
      scoped()
        .select('id', 'email', 'role', 'created_at', 'expires_at')
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .offset((page - 1) * limit)
        .limit(limit),
    ])
    const count = Number(total)
    const next = page * limit < count ? page + 1 : null
    const path = `/api/v1/workspaces/${selected}/invitations`
    return response.ok({
      items: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
      total: count,
      page,
      next: next === null ? null : `${path}?page=${next}&limit=${limit}`,
    })
  }
}
```

The response selects only display fields; never serialize `token_hash`, invitation proof, or
the full row. The email address is visible only to authorized workspace admins. Each page
request repeats authorization and scoping. Offset pages can skip or repeat records during
concurrent changes; use a workspace-bound keyset cursor if stable traversal is required.

Mount the replacement in `start/account_kit_routes.ts` with the same guard as the managed
routes. Exclude **exactly** `account.invitation.list`: send, resend, revoke, inspect, and accept
remain mounted. Import this route file once from `start/routes.ts`.

```ts
// start/account_kit_routes.ts
import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import {
  createManagedGuard,
  managedAccountMiddleware,
  registerManagedRoutes,
} from 'adonisjs-account-kit/http'

const guard = createManagedGuard({
  strategy: 'access_tokens',
  name: 'api',
  loadUser: async () => (await import('#models/user')).default,
})
const kit = () => app.container.make(AccountKit)

registerManagedRoutes(router, {
  prefix: '/api/v1',
  enabled: ['invitations'],
  kit,
  guard,
  except: ['account.invitation.list'],
})

router
  .get('/api/v1/workspaces/:workspaceId/invitations', [
    () => import('#controllers/workspace_invitations_controller'),
    'index',
  ])
  .use(managedAccountMiddleware({ kit, guard, active: true }))
```

```ts
// At the end of start/routes.ts
import './account_kit_routes.js'
```

The middleware authenticates the guard and checks the account's current revision and active
state. The controller checks workspace admin membership. If you have an existing managed mount,
add only this exclusion and application route; retain its other groups and settings. For
setup-generated mounts, persist the exclusion in `managedExcept`. If you need no listing
endpoint, keep the exclusion and omit the application route. Client filtering cannot authorize
an unscoped list.

## Limits to plan around

- **One pending invitation per address.** `account_invitations.email` is unique. An address
  cannot hold invitations to two workspaces at once; a second send throws
  `InvitationPendingError`.
- **Invitations are for new accounts.** Inviting an existing account throws
  `EmailAlreadyRegisteredError`. Add existing users to a workspace with your own flow.
- **Rate limits are shared.** Use one `limiterSecret` and `limiterNamespace` per deployment,
  not per workspace.

## Separate databases per workspace

`AccountKit` can be constructed with `new AccountKit({ config, db, limiter })`, so a
database-per-workspace app can build one instance per connection. Each database needs the
package migrations. This setup is not covered by the package tests.
