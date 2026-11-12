# US-ACCOUNT-11 — Resend an invitation

As an authorized inviter, I want to issue a fresh invitation delivery for an eligible recipient so that I can recover a link without changing host authorization.

**Status:** Current
**Access:** Host authorization callback and configured resend limits apply.
**Entry:** Host calls `invitations.resend`; no built-in resend UI.
**Documentation:** [usage.md](../docs/guide/usage.md)
**Source:** [`src/invitations.ts`](../src/invitations.ts)
**Coverage:** [`tests/invitations_resend_revoke.spec.ts`](../tests/invitations_resend_revoke.spec.ts)

## Acceptance criteria

- **Inputs and result:** inviter context and invitation identifier; service returns current invitation outcome. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- eligible invitation is refreshed/delivered after commit.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Inviter requests resend"]
    U1["unauthorized, expired, revoked or rate-limited state is refused"]
    U0 --> U1
    U2["eligible invitation is refreshed/delivered after commit."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["invitations.resend"]
    C1["authorize and validate existing invitation"]
    C0 --> C1
    C2["transaction rotates stored proof/expiry"]
    C1 --> C2
    C3["post-commit provision"]
    C2 --> C3
    C4["return result."]
    C3 --> C4
```

**Code references:** [implementation](../src/invitations.ts), [`tests/invitations_resend_revoke.spec.ts`](../tests/invitations_resend_revoke.spec.ts)
