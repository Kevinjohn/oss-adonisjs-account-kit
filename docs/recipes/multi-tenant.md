# Multi-tenant applications

Account Kit has no tenant concept. Accounts are global: one row per email address in one users
table. Tenancy lives in your own membership table. This recipe shows the usual shape.

## One account, many workspaces

Keep a `memberships` table (`user_id`, `workspace_id`, `role`). Account Kit handles the account;
your code handles membership.

## Invite into a workspace

An invitation carries an email address and a `role` string of up to 64 characters. Encode the
workspace in the role and check it in your callbacks:

```ts
// config/account_kit.ts
const parseRole = (role: string) => {
  const [workspaceId, memberRole] = role.split(':')
  return { workspaceId: Number(workspaceId), memberRole }
}

authorize: {
  invite: async (actor, role, context) => {
    const { workspaceId, memberRole } = parseRole(role)
    return memberRole !== 'owner' && isWorkspaceAdmin(actor.id, workspaceId, context?.trx)
  },
  manageInvitation: async (actor, invitation, context) =>
    isWorkspaceAdmin(actor.id, parseRole(invitation.role).workspaceId, context?.trx),
  listInvitations: async (actor) => isAdminAnywhere(actor.id),
},
onInvitationAccepted: async (user, invitation, trx) => {
  const { workspaceId, memberRole } = parseRole(invitation.role)
  await trx.table('memberships').insert({ user_id: user.id, workspace_id: workspaceId, role: memberRole })
},
```

```ts
await kit.invitations.send({
  actorId: admin.id,
  email: 'new@acme.test',
  role: `${workspace.id}:member`,
})
```

## Limits to plan around

- **One pending invitation per address.** `account_invitations.email` is unique, so an address
  cannot hold invitations to two workspaces at once. Sending a second throws
  `InvitationPendingError`.
- **Invitations are for new accounts.** Inviting an address that already has an account throws
  `EmailAlreadyRegisteredError`. Add existing users to a workspace with your own flow.
- **`listInvitations` is not filtered by workspace.** It returns the invitations Account Kit
  stores; filter by the role prefix before showing them.
- **Rate limits are shared.** Use one `limiterSecret` and `limiterNamespace` per deployment, not
  per tenant.

## Separate databases per tenant

`AccountKit` can be constructed directly with `new AccountKit({ config, db, limiter })`, so a
database-per-tenant app can build one instance per tenant connection. Each tenant database needs
the package migrations. This setup is not covered by the package tests.
