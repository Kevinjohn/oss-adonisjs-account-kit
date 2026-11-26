# US-ACCOUNT-01 — Request and complete password recovery

As an account holder, I want to request a password reset and use its one-time link so that I can regain access without revealing whether an address has an account.

**Status:** Current when `passwordReset` is enabled
**Access:** Anyone may request; only a valid reset-token holder may complete. Host owns HTTP response and delivery configuration.
**Entry:** Host calls `passwordReset.request`, optional `passwordReset.inspect`, and `passwordReset.reset`. The managed equivalents are POST `auth/password-reset` and GET/POST `auth/password-reset/:token`.
**Documentation:** [getting-started.md](../docs/guide/getting-started.md)
**Source:** [`src/password_reset.ts`](../src/password_reset.ts)
**Coverage:** [`tests/password_reset_request.spec.ts`](../tests/password_reset_request.spec.ts), [`tests/password_reset_redeem.spec.ts`](../tests/password_reset_redeem.spec.ts)

## Acceptance criteria

- **Inputs and result:** `passwordReset.request({ email, clientKey })` returns `void`; `inspect({ token })` is read-only and returns a boolean; `reset({ token, password })` returns the updated account. When delivery and follow-up callbacks succeed, the request returns the same acknowledgement after the same minimum delay for known and unknown addresses. A known-address delivery or follow-up callback failure may surface as a service error after issuance commits.
- Resetting an inactive account confirms its email and applies live matching invitation grants when invitations are enabled.
- Issuing a fresh reset link invalidates the older reset link for that account. A pre-commit issuance or reset failure rolls back that transaction. A fault after commit preserves the issued proof or changed password; the service still attempts the relevant follow-ups before surfacing the committed failure.
- Managed request validates `email`, supplies the request IP as `clientKey`, and returns 202 with the generic message, reporting any committed issuance failure separately. Managed inspection returns `{ valid: true }` or an invalid-proof response. Managed completion requires the [password and confirmation fields](REFERENCE.md#managed-password-fields) and returns `{ reset: true }`.
- If the managed write recognises a committed follow-up failure, it returns 202 with `{ committed: true }`.
  The reset-request endpoint instead returns its generic 202 message.

## User flow

```mermaid
flowchart TD
  A["Submit email to request a reset link"] --> B{"Request accepted?"}
  B -->|No| R["Show request error"]
  B -->|Yes| C["See a generic acknowledgement; open the link if delivered"]
  C --> D["Optionally check that the link is usable"]
  D --> E["Submit link and new password"]
  E -->|Invalid link| F["Request another link"]
  E -->|Password refused| G["Correct the password and resubmit"]
  E -->|Reset committed| H["Password changes and older credentials end"]
  H -->|Follow-up failure| I["Report failure; use the new password"]
```

## Code flow

```mermaid
flowchart TD
  A["Managed password-reset request validates email and supplies request IP; host may call directly"] --> B["passwordReset.request validates input, throttles client and email and looks up account"]
  B -->|Invalid input, throttle or other error| ERR["Wait for timing floor and propagate refusal"]
  B -->|Accepted| C{"Account exists with matching email after lock and re-read?"}
  C -->|No| D["Skip delivery; return after timing floor"]
  C -->|Yes| E["Upsert hashed token and run onPasswordResetIssuedTransaction; commit"]
  E -->|Pre-commit failure; issuance rolled back| ERR
  E -->|Committed result, including recovered fault| F["Run provision and follow-ups; wait for timing floor"]
  F -->|Committed failure| G["Service throws; managed handler reports failure and returns generic 202"]
  D -->|Managed| H["Generic 202"]
  F -->|Success| H2["Service resolves void; managed handler returns generic 202"]
  I["Managed GET or host call"] --> J["passwordReset.inspect checks token expiry and current email without consuming; return boolean or managed proof response"]
  K["Managed POST validates password fields and policy; host may call directly"] --> L["passwordReset.reset validates policy and token; prepare password"]
  L -->|Invalid password or proof| REJ["Reject without a password change"]
  L -->|Valid shape| M["Transaction consumes matching live token; store password and clear pending email correction and social state where configured"]
  M -->|Token invalid or pre-commit failure| REJ
  M --> N["If inactive, verify email and apply pending invitations; clear verification proof and advance credentials"]
  N --> P["Commit; settleCommitted recovers the committed result even if the transaction reports a fault"]
  P --> O["Attempt observers, notices and invitation follow-ups; return account or managed reset acknowledgement, or surface committed failure to service callers and acknowledge it in managed HTTP"]
```

**Code references:** [implementation](../src/password_reset.ts), [`tests/password_reset_request.spec.ts`](../tests/password_reset_request.spec.ts), [`tests/password_reset_redeem.spec.ts`](../tests/password_reset_redeem.spec.ts), [request implementation](../src/password_reset_request.ts), [managed password reset](../src/http/handlers_password_reset.ts), [managed committed-failure response](../src/http/managed.ts)
