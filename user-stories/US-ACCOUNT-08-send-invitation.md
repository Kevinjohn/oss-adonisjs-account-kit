# US-ACCOUNT-08 — Invite a person to the application

As an authorized inviter, I want to send an invitation for a recipient and application role so that I can give the recipient a bounded invitation path.

**Status:** Current when the host explicitly enables the opt-in `invitations` capability
**Access:** Host `authorize.invite(actor, role, { scope, trx? })` authorizes the inviter, role and scope. It receives no target email; recipient-specific policy is host-owned separately. The host decides what an invitation role means.
**Entry:** Host calls `invitations.send`; optional managed invitation route.
**Documentation:** [usage.md](../docs/guide/usage.md)
**Source:** [`src/invitations.ts`](../src/invitations.ts)
**Coverage:** [`tests/invitations_send.spec.ts`](../tests/invitations_send.spec.ts)

## Acceptance criteria

- **Inputs and result:** `invitations.send({ actorId, email, role, scope? })` returns the invitation. Email must be email-shaped; role is a string of 1–64 characters; scope is an optional string of 1–255 characters, with omitted or `null` meaning unscoped. Host `authorize.invite(actor, role, { scope, trx? })` decides permission and role meaning, without receiving the target email.

- A registered recipient or an existing pending invitation for the same normalized email and scope is refused with its defined error; a pending invitation in another scope does not block this send. Delivery failure after commit leaves the new invitation recorded and is surfaced.

## User flow

```mermaid
flowchart TD
 A["Authorized inviter submits recipient, role and optional 1–255 character scope"] --> B{"Does invite authorization and input validation pass?"}
 B -->|No| C["Return refusal; no invitation is issued"]
 B -->|Yes| D{"Does recipient already have an account or a pending invite in this scope?"}
 D -->|Yes| E["Refuse with EmailAlreadyRegisteredError or same-scope InvitationPendingError"]
 D -->|No| F["Store invitation and deliver link after commit"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["invitations.send"] --> B["Require invitations capability; validate email/role/scope; load actor and authorize invite(actor, role, {scope})"]
 B --> C["Spend actor budget before checking registered address"]
 C --> D["Spend recipient budget; refuse an existing same-email/same-scope invite; store token hash transactionally"]
 D --> E["Commit; deliver invitation and lifecycle event"]
 E --> F["Return Invitation or committed follow-up failure"]
```

**Code references:** [implementation](../src/invitations.ts), [`tests/invitations_send.spec.ts`](../tests/invitations_send.spec.ts)
