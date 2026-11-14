# US-ACCOUNT-12 — Revoke an invitation

As an authorized inviter, I want to cancel an outstanding invitation so that I can prevent its token from granting membership.

**Status:** Current when the host explicitly enables the opt-in `invitations` capability
**Access:** Host authorization callback must permit managing this invitation.
**Entry:** Host calls `invitations.revoke`; no built-in revoke UI.
**Documentation:** [usage.md](../docs/guide/usage.md)
**Source:** [`src/invitation_management.ts`](../src/invitation_management.ts)
**Coverage:** [`tests/invitations_resend_revoke.spec.ts`](../tests/invitations_resend_revoke.spec.ts)

## Acceptance criteria

- **Inputs and result:** `invitations.revoke({ actorId, invitationId })` returns `void`. `authorize.manageInvitation` must allow the actor; the invitation row with that id is locked and deleted, whether it is still pending or already expired, and its token can no longer be accepted. A missing row throws `InvitationNotFoundError`; a refusal from `manageInvitation` throws `InvitationManagementDeniedError`.

## User flow

```mermaid
flowchart TD
 A["Authorized inviter chooses revoke on an invitation"] --> B{"Does manageInvitation allow this action?"}
 B -->|No| C["Return authorization refusal"]
 B -->|Yes| D["Delete the invitation"]
 D --> E["A later acceptance with its token fails"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["invitations.revoke"] --> B["Load actor; lock the invitation row"]
 B --> C{"Row found?"}
 C -->|No| D["Throw InvitationNotFoundError"]
 C -->|Yes| M{"authorize.manageInvitation allows?"}
 M -->|No| N["Throw InvitationManagementDeniedError"]
 M -->|Yes| E["Delete invitation row and resolve void"]
```

**Code references:** [implementation](../src/invitation_management.ts), [`tests/invitations_resend_revoke.spec.ts`](../tests/invitations_resend_revoke.spec.ts)
