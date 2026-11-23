# US-ACCOUNT-10 — Review invitations

As an authorised inviter or operator, I want to list invitations visible under host authorisation so that I can see current invitation state before taking action.

**Status:** Current when the host explicitly enables the opt-in `invitations` capability
**Access:** Host list authorisation callback and the caller-supplied `limit` (default 25, maximum 100), `cursor` and `scope` inputs determine visible results.
**Entry:** Host calls `invitations.list` with actor and paging inputs; no built-in invitation screen.
**Documentation:** [usage.md](../docs/guide/usage.md)
**Source:** [`src/invitation_management.ts`](../src/invitation_management.ts)
**Coverage:** [`tests/invitation_listing.spec.ts`](../tests/invitation_listing.spec.ts), [`tests/invitations_inspection.spec.ts`](../tests/invitations_inspection.spec.ts)

## Acceptance criteria

- **Inputs and result:** `invitations.list({ actorId, limit?, cursor?, scope? })` returns `{ items, nextCursor }`. `limit` defaults to 25 and cannot exceed 100; omitted scope lists every scope, while `null` selects unscoped invitations. `authorize.listInvitations` controls visibility.

## User flow

```mermaid
flowchart TD
 A["Inviter requests an authorised invitation page"] --> B{"Does listInvitations authorise this actor and scope?"}
 B -->|No| C["Return authorisation refusal"]
 B -->|Yes| D["Show pending invitations and next cursor, or an empty page"]
 D --> E["Use nextCursor to request another page"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["invitations.list"] --> B["Validate limit, decode cursor, normalise optional scope; load actor and authorise"]
 B --> C{"Authorised?"}
 C -->|No| D["Return AuthorizationError"]
 C -->|Yes| E["Query unexpired rows with normalised scope and cursor"]
 E --> F["Return InvitationPage items and nextCursor"]
```

**Code references:** [implementation](../src/invitation_management.ts), [`tests/invitation_listing.spec.ts`](../tests/invitation_listing.spec.ts), [`tests/invitations_inspection.spec.ts`](../tests/invitations_inspection.spec.ts)
