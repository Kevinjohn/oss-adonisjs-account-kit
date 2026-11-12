# US-ACCOUNT-08 — Invite a person to the application

As an authorized inviter, I want to send an invitation for a recipient and application role so that I can give the recipient a bounded invitation path.

**Status:** Current
**Access:** Host callback authorizes inviter, target email and role; host decides what invitation role means.
**Entry:** Host calls `invitations.send`; optional managed invitation route.
**Documentation:** [usage.md](../docs/guide/usage.md)
**Source:** [`src/invitations.ts`](../src/invitations.ts)
**Coverage:** [`tests/invitations_send.spec.ts`](../tests/invitations_send.spec.ts)

## Acceptance criteria

- **Inputs and result:** inviter/current context, recipient email, role and host-configured scope/data. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- accepted invite is stored and delivered after commit.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Authorized inviter submits recipient and role"]
    U1["callback refusal creates no invitation"]
    U0 --> U1
    U2["accepted invite is stored and delivered after commit."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["sendInvitation"]
    C1["authorization callback and input rules"]
    C0 --> C1
    C2["transaction stores token hash/expiry"]
    C1 --> C2
    C3["post-commit invitation provision"]
    C2 --> C3
    C4["return invitation result."]
    C3 --> C4
```

**Code references:** [implementation](../src/invitations.ts), [`tests/invitations_send.spec.ts`](../tests/invitations_send.spec.ts)
