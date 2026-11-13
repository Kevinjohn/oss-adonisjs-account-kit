# US-ACCOUNT-38 — Confirm an email address

As an account holder with an activation link, I want to confirm my email address so that my account becomes active.

**Status:** Current when `emailVerification` is enabled
**Access:** A valid single-use activation token and a password accepted by configured policy are required.
**Entry:** Host calls `emailVerification.inspect({ token })` to check without consuming, then `emailVerification.complete({ token, password })`; the optional managed route also requires the confirmation field in the [managed password fields reference](REFERENCE.md#managed-password-fields).
**Documentation:** [Registration](../docs/guide/registration.md)
**Source:** [`src/verification.ts`](../src/verification.ts)
**Coverage:** [`tests/verification.spec.ts`](../tests/verification.spec.ts)

## Acceptance criteria

- Inspection takes `token` and returns a boolean without spending it. Completion takes `token` and a new policy-valid password and returns `verified`.
- An invalid, expired or already-used token does not activate the account; a valid token is consumed once, confirms the address, sets the password, clears applicable recovery proofs and applies any matching pending invitation grant.
- Credential observers and lifecycle callbacks run after commit. If a follow-up fails, activation and proof consumption remain committed; the user must not retry the consumed link as though activation rolled back.

## User flow

```mermaid
flowchart TD
 A["Account holder opens activation link"] --> B{"Does emailVerification.inspect return true?"}
 B -->|No| C["Ask host for a fresh verification link"]
 B -->|Yes| D["Submit token and new password"]
 D --> E{"Is password accepted by configured policy?"}
 E -->|No| F["Keep account inactive and correct password"]
 F --> D
 E -->|Yes| G["Confirm address, set password, clear recovery proofs and apply a matching pending invitation"]
 G --> H{"Did post-commit observers and lifecycle follow-ups succeed?"}
 H -->|Yes| I["Show activation complete"]
 H -->|No| J["Report follow-up failure; activation remains committed and this link cannot be retried"]
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
 F --> G["Clear recovery proofs and apply matching pending invitation in the claim transaction"]
 G --> H["Commit activation and consume proof"]
 H --> I["Run credential observer, lifecycle and invitation follow-ups"]
 I --> J{"Follow-ups succeeded?"}
 J -->|Yes| K["Return verified"]
 J -->|No| L["Surface follow-up failure; committed activation and consumed proof remain"]
```

**Code references:** [`inspectVerification` and `completeVerification`](../src/verification.ts), [`verification tests`](../tests/verification.spec.ts)
