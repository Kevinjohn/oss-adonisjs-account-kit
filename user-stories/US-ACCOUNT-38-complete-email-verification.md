# US-ACCOUNT-38 — Confirm an email address

As an account holder with an activation link, I want to confirm my email address so that my account becomes active.

**Status:** Current when `emailVerification` is enabled
**Access:** A valid single-use activation token and a password accepted by configured policy are required.
**Entry:** Host calls `emailVerification.inspect` or `emailVerification.complete`. Managed GET/POST `auth/email-verification/:token` are public proof routes. The POST requires the [managed password fields](REFERENCE.md#managed-password-fields).
**Documentation:** [Registration](../docs/guide/registration.md)
**Source:** [`src/verification.ts`](../src/verification.ts)
**Coverage:** [`tests/verification.spec.ts`](../tests/verification.spec.ts)

## Acceptance criteria

- Inspection takes `token` and returns a boolean without spending it. Completion takes `token` and a new policy-valid password and returns `verified`.
- An invalid, expired or already-used token does not activate the account; a valid token is consumed once, confirms the address, sets the password, invalidates prior credentials, clears applicable recovery proofs and applies all live matching invitation grants when invitations are enabled.
- Credential observers and lifecycle callbacks run after commit. If a follow-up fails, activation and proof consumption remain committed; the user must not retry the consumed link as though activation rolled back.
- Managed inspection returns 200 with `{ valid: true }` or an invalid-proof response. Managed completion returns 200 with `{ verified: true }` on success.
- If the managed write recognises a committed follow-up failure, it returns 202 with `{ committed: true }`.

## User flow

```mermaid
flowchart TD
  A["Open activation link and optionally check it"] --> B{"Link usable?"}
  B -->|No| C["Request a fresh verification link"]
  B -->|Yes or skipped check| D["Submit token and new password"]
  D -->|Password refused| F["Correct the password and resubmit"]
  D -->|Expired, used or stale link| C
  D -->|Committed| G["Address confirmed, password set and prior credentials invalidated"]
  G -->|Success| I["See verification complete"]
  G -->|Follow-up failure| J["Activation remains committed; use the new password"]
```

## Code flow

```mermaid
flowchart TD
  M["Managed inspection or host inspection"] --> A["emailVerification.inspect checks capability and reads live matching activation proof without consuming"]
  A --> Q["Return boolean or managed proof response"]
  N["Managed POST checks password and confirmation; host may call directly"] --> E["emailVerification.complete checks capability, password and token, then prepares password"]
  E --> F["Transaction consumes live matching activation proof"]
  F -->|Refused| R["Roll back and surface invalid token"]
  F -->|Accepted| G["Store password; activateClaim confirms email, invokes host callbacks for live invitations, and clears password reset proofs and pending social state as configured"]
  G --> H["invalidateChangedCredentials invalidates prior credentials; commit"]
  H --> I["Run credential observer, lifecycle and invitation follow-ups"]
  I -->|Success| K["Return verified or managed verified acknowledgement"]
  I -->|Failure| L["Surface follow-up failure with activation and consumption committed"]
```

**Code references:** [`inspectVerification` and `completeVerification`](../src/verification.ts), [`verification tests`](../tests/verification.spec.ts), [managed verification](../src/http/handlers_email_verification.ts), [activation transaction](../src/activation_claim.ts), [managed committed-failure response](../src/http/managed.ts)
