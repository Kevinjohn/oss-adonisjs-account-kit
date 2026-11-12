# US-ACCOUNT-09 — Accept an invitation

As an invited person, I want to redeem the invitation sent to their address so that I can join through the host-approved invitation path.

**Status:** Current
**Access:** Valid unused invitation token and matching recipient proof; host callback owns membership grant.
**Entry:** Host calls `invitations.accept`; optional managed acceptance route.
**Documentation:** [usage.md](../docs/guide/usage.md)
**Source:** [`src/invitations.ts`](../src/invitations.ts)
**Coverage:** [`tests/invitations_acceptance.spec.ts`](../tests/invitations_acceptance.spec.ts)

## Acceptance criteria

- **Inputs and result:** invitation token, recipient proof and registration fields/password where required by configured acceptance path. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- host callback records application membership in the same transaction.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Recipient opens invite"]
    U1["invalid, expired or mismatched token is refused"]
    U0 --> U1
    U2["valid invite is consumed once"]
    U1 --> U2
    U3["host callback records application membership in the same transaction."]
    U2 --> U3
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["acceptInvitation"]
    C1["transaction locks/checks invitation, matches recipient and consumes it"]
    C0 --> C1
    C2["onInvitationAccepted runs in transaction"]
    C1 --> C2
    C3["commit and return acceptance."]
    C2 --> C3
```

**Code references:** [implementation](../src/invitations.ts), [`tests/invitations_acceptance.spec.ts`](../tests/invitations_acceptance.spec.ts)
