# US-ACCOUNT-07 — Update configured profile fields

As a signed-in account holder, I want to change profile fields accepted by the host configuration so that I can keep account details current.

**Status:** Current when `emailPasswordManagement` is enabled
**Access:** Current account; host defines allowed fields, mapping and request authorization.
**Entry:** Host calls `emailPasswordManagement.updateProfile`; optional managed profile route with configured validator/representation.
**Documentation:** [account-operations.md](../docs/guide/account-operations.md)
**Source:** [`src/profile_update.ts`](../src/profile_update.ts)
**Coverage:** [`tests/credentials_profile.spec.ts`](../tests/credentials_profile.spec.ts)

## Acceptance criteria

- **Inputs and result:** current account and configured profile fields; field allowlist and constraints are host-configured. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- valid mapped changes are saved and represented using host policy.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Person submits profile changes"]
    U1["unknown/disallowed fields are rejected or ignored as configured"]
    U0 --> U1
    U2["valid mapped changes are saved and represented using host policy."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["updateProfile"]
    C1["map and validate configured fields"]
    C0 --> C1
    C2["transaction updates account and revision behavior"]
    C1 --> C2
    C3["return current safe account representation."]
    C2 --> C3
```

**Code references:** [implementation](../src/profile_update.ts), [`tests/credentials_profile.spec.ts`](../tests/credentials_profile.spec.ts)
