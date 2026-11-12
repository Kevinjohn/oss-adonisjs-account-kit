# US-ACCOUNT-38 — Confirm an email address

As an account holder with an activation link, I want to confirm my email address so that my account becomes active.

**Status:** Current when `emailVerification` is enabled
**Access:** A valid single-use activation token and a password accepted by configured policy are required.
**Entry:** Host calls `emailVerification.inspect({ token })` to check without consuming, then `emailVerification.complete({ token, password })`; optional managed routes are separate.
**Documentation:** [Registration](../docs/guide/registration.md)
**Source:** [`src/verification.ts`](../src/verification.ts)
**Coverage:** [`tests/verification.spec.ts`](../tests/verification.spec.ts)

## Acceptance criteria

- Inspection takes `token` and returns a boolean without spending it. Completion takes `token` and a new policy-valid password and returns `verified`.
- An invalid, expired or already-used token does not activate the account; a valid token is consumed once, confirms the address and sets the password.

## User flow

```mermaid
flowchart TD
 A["Account holder opens activation link"] --> B{"Does emailVerification.inspect return true?"}
 B -->|No| C["Ask host for a fresh verification link"]
 B -->|Yes| D["Submit token and new password"]
 D --> E{"Is password accepted by configured policy?"}
 E -->|No| F["Keep account inactive and correct password"]
 F --> D
 E -->|Yes| G["Confirm address and activate account"]
```

## Code flow

Scope: verification transaction and service result. Host owns the form, route and error presentation.

```mermaid
flowchart TD
 A["emailVerification.inspect({ token })"] --> B["Read proof status without consuming"]
 B --> C{"Usable?"}
 C -->|No| D["Return false"]
 C -->|Yes| E["emailVerification.complete({ token, password })"]
 E --> F["Transaction consumes proof, confirms email and stores password"]
 F --> G["Return verified; subsequent use of token is refused"]
```

**Code references:** [`inspectVerification` and `completeVerification`](../src/verification.ts), [`verification tests`](../tests/verification.spec.ts)
