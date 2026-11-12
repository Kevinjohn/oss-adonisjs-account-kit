# US-ACCOUNT-06 — Change and confirm the account email

As a signed-in account holder, I want to request a new email and confirm ownership so that I can keep the old address active until the new one is proven.

**Status:** Current when `emailPasswordManagement` is enabled
**Access:** Authenticated current account; new address must pass uniqueness and confirmation checks.
**Entry:** Host calls `requestEmailChange`, then the recipient follows the confirmation link consumed by `emailVerification.completeEmailChange`; optional managed profile route.
**Documentation:** [account-operations.md](../docs/guide/account-operations.md)
**Source:** [`src/profile_update.ts`](../src/profile_update.ts)
**Coverage:** [`tests/credentials_email_change_completion.spec.ts`](../tests/credentials_email_change_completion.spec.ts)

## Acceptance criteria

- **Inputs and result:** actorId, new email and currentPassword or supported recent proof; confirmation token for completion. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- valid token switches address and invalidates older credentials; stale token is refused.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Person requests new address"]
    U1["conflict or policy failure leaves current address"]
    U0 --> U1
    U2["confirmation link is sent"]
    U1 --> U2
    U3["valid token switches address and invalidates older credentials; stale token is refused."]
    U2 --> U3
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["requestEmailChange"]
    C1["transaction stores pending address/token"]
    C0 --> C1
    C2["provision after commit; completeEmailChange"]
    C1 --> C2
    C3["consume proof, replace email and revise credential in transaction"]
    C2 --> C3
    C4["post-commit notices."]
    C3 --> C4
```

**Code references:** [implementation](../src/profile_update.ts), [`tests/credentials_email_change_completion.spec.ts`](../tests/credentials_email_change_completion.spec.ts)
