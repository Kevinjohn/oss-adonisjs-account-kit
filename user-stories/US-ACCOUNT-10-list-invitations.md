# US-ACCOUNT-10 — Review invitations

As an authorized inviter or operator, I want to list invitations visible under host authorization so that I can see current invitation state before taking action.

**Status:** Current
**Access:** Host list authorization callback and configured page size/cursor determine visible results.
**Entry:** Host calls `invitations.list` with actor and paging inputs; no built-in invitation screen.
**Documentation:** [usage.md](../docs/guide/usage.md)
**Source:** [`src/invitations.ts`](../src/invitations.ts)
**Coverage:** [`tests/invitations_resend_revoke.spec.ts`](../tests/invitations_resend_revoke.spec.ts)

## Acceptance criteria

- **Inputs and result:** actor context and optional page cursor/limit; returns authorized invitation page. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- authorized results and next cursor are returned; empty page is a valid result.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Inviter requests a page"]
    U1["callback denies or scopes visibility"]
    U0 --> U1
    U2["authorized results and next cursor are returned; empty page is a valid result."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["invitations.list"]
    C1["authorize listing and apply configured paging/filter"]
    C0 --> C1
    C2["query invitation rows"]
    C1 --> C2
    C3["return page and cursor."]
    C2 --> C3
```

**Code references:** [implementation](../src/invitations.ts), [`tests/invitations_resend_revoke.spec.ts`](../tests/invitations_resend_revoke.spec.ts)
