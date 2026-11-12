# US-ACCOUNT-08 — Invite a person to the application

As an authorized inviter, I want to send an invitation for a recipient and application role so that I can give the recipient a bounded invitation path.

**Status:** Current
**Access:** Host callback authorizes inviter, target email and role; host decides what invitation role means.
**Entry:** Host calls `invitations.send`; optional managed invitation route.
**Documentation:** [usage.md](../docs/guide/usage.md)
**Source:** [`src/invitations.ts`](../src/invitations.ts)
**Coverage:** [`tests/invitations_send.spec.ts`](../tests/invitations_send.spec.ts)

## Acceptance criteria

- **Inputs and result:** `invitations.send({ actorId, email, role, scope? })` returns the invitation. Email must be email-shaped; role is a string of 1–64 characters; omitted or `null` scope means unscoped. Host `authorize.invite` decides permission and role meaning.

## User flow

```mermaid
flowchart TD
 A["Authorized inviter submits recipient, role and optional scope"] --> B{"Does invite authorization and input validation pass?"}
 B -->|No| C["Return refusal; no invitation is issued"]
 B -->|Yes| D{"Does recipient already have an account or pending invite?"}
 D -->|Yes| E["Return registered or pending invitation result"]
 D -->|No| F["Store invitation and deliver link after commit"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["invitations.send"] --> B["Validate email/role/scope; load actor and authorize invite"]
 B --> C["Spend actor budget before checking registered address"]
 C --> D["Spend recipient budget and store token hash transactionally"]
 D --> E["Commit; deliver invitation and lifecycle event"]
 E --> F["Return Invitation or committed follow-up failure"]
```

**Code references:** [implementation](../src/invitations.ts), [`tests/invitations_send.spec.ts`](../tests/invitations_send.spec.ts)
