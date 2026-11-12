# US-ACCOUNT-35 — Deliver account notifications

As an application operator, I want to connect account events to mail or host-owned notification delivery so that I can deliver verification, recovery and lifecycle messages using app policy.

**Status:** Current
**Access:** Host configures mail/provision callbacks, translations and delivery transport; provider acceptance is not recipient delivery.
**Entry:** Configure notification callbacks or use maintained mail/log helpers; service operations invoke provisions at documented transaction boundaries.
**Documentation:** [notifications.md](../docs/guide/notifications.md)
**Source:** [`src/notifications.ts`](../src/notifications.ts)
**Coverage:** [`tests/notifications.spec.ts`](../tests/notifications.spec.ts)

## Acceptance criteria

- **Inputs and result:** notification callback set, locale/translation configuration and provision data; exact message varies by event. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- post-commit delivery failure is surfaced without undoing committed account mutation.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Operator selects transport"]
    U1["event provisions are formatted and queued/sent"]
    U0 --> U1
    U2["post-commit delivery failure is surfaced without undoing committed account mutation."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["Service transaction commits"]
    C1["notification provision callback executes after commit"]
    C0 --> C1
    C2["configured adapter formats/delivers or reports delivery failure."]
    C1 --> C2
```

**Code references:** [implementation](../src/notifications.ts), [`tests/notifications.spec.ts`](../tests/notifications.spec.ts)
