# US-ACCOUNT-12 — Revoke an invitation

As an authorized inviter, I want to cancel an outstanding invitation so that I can prevent its token from granting membership.

**Status:** Current when the host explicitly enables the opt-in `invitations` capability
**Access:** Host authorization callback must permit managing this invitation.
**Entry:** Host calls `invitations.revoke`; no built-in revoke UI.
**Documentation:** [usage.md](../docs/guide/usage.md)
**Source:** [`src/invitations.ts`](../src/invitations.ts)
**Coverage:** [`tests/invitations_resend_revoke.spec.ts`](../tests/invitations_resend_revoke.spec.ts)

## Acceptance criteria

- **Inputs and result:** `invitations.revoke({ actorId, invitationId })` returns `void`. `authorize.manageInvitation` must allow the actor; the pending invitation is deleted and its token can no longer be accepted.

## User flow

```mermaid
flowchart TD
 A["Authorized inviter chooses revoke on a pending invitation"] --> B{"Does manageInvitation allow this action?"}
 B -->|No| C["Return authorization refusal"]
 B -->|Yes| D["Delete the pending invitation"]
 D --> E["A later acceptance with its token fails"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["invitations.revoke"] --> B["Load actor and call authorize.manageInvitation"]
 B --> C{"Authorized and pending row found?"}
 C -->|No| D["Return defined refusal"]
 C -->|Yes| E["Delete invitation row and resolve void"]
```

**Code references:** [implementation](../src/invitations.ts), [`tests/invitations_resend_revoke.spec.ts`](../tests/invitations_resend_revoke.spec.ts)
