# US-ACCOUNT-01 — Request and complete password recovery

As an account holder, I want to request a password reset and use its one-time link so that I can regain access without revealing whether an address has an account.

**Status:** Current
**Access:** Anyone may request; only a valid reset-token holder may complete. Host owns HTTP response and delivery configuration.
**Entry:** Host calls `passwordReset.request({ email, clientKey })` then `passwordReset.reset({ token, password })`; managed routes are optional.
**Documentation:** [getting-started.md](../docs/guide/getting-started.md)
**Source:** [`src/password_reset.ts`](../src/password_reset.ts)
**Coverage:** [`tests/password_reset_request.spec.ts`](../tests/password_reset_request.spec.ts), [`tests/password_reset_redeem.spec.ts`](../tests/password_reset_redeem.spec.ts)

## Acceptance criteria

- **Inputs and result:** `passwordReset.request({ email, clientKey })` returns `void`; `inspect({ token })` is read-only and returns a boolean; `reset({ token, password })` returns the updated account. The request returns the same acknowledgement after the same minimum delay for known and unknown addresses.

## User flow

```mermaid
flowchart TD
 A["Person submits email and trusted clientKey"] --> B["passwordReset.request"]
 B --> C["Same acknowledgement for known and unknown addresses"]
 C --> D["Known account receives expiring one-use link"]
 D --> E{"Does passwordReset.inspect report the token usable?"}
 E -->|No| F["Keep password unchanged and request a new link"]
 F --> A
 E -->|Yes| G["Submit token and policy-valid password"]
 G --> H["passwordReset.reset changes password and ends older credentials"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["passwordReset.request"] --> B["Throttle client and address; transact hashed token issuance"]
 B --> C["Commit; send provision; return generic acknowledgement"]
 D["passwordReset.reset"] --> E["Consume token and store password inside transaction"]
 E --> F["Invalidate older credentials; commit account result"]
 F --> G["Run post-commit notice; follow-up failure does not undo reset"]
```

**Code references:** [implementation](../src/password_reset.ts), [`tests/password_reset_request.spec.ts`](../tests/password_reset_request.spec.ts), [`tests/password_reset_redeem.spec.ts`](../tests/password_reset_redeem.spec.ts)
