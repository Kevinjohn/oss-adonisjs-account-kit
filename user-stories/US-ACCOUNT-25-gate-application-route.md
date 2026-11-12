# US-ACCOUNT-25 — Gate a protected route by admission

As an application developer, I want to require admission before protected application data so that I can prevent non-admitted credentials from entering protected routes.

**Status:** Current when admission is installed and app applies middleware
**Access:** Host chooses guarded routes and keeps pre-admission status/sign-out routes reachable.
**Entry:** Host applies `admissionMiddleware` or calls `admission.require` in its own middleware/controller.
**Documentation:** [admission.md](../docs/guide/admission.md)
**Source:** [`src/admission/middleware.ts`](../src/admission/middleware.ts)
**Coverage:** [`tests/admission_gate.spec.ts`](../tests/admission_gate.spec.ts)

## Acceptance criteria

- **Inputs and result:** `AccountAdmission.require(current, { active? } = {})` returns account and decision or throws for invalid credential, inactive account when `active` is not false, or an unmet requirement. The host applies it only to routes that should require admission.

## User flow

```mermaid
flowchart TD
 A["Request reaches host-protected route"] --> B{"Does selected guard credential/revision validate?"}
 B -->|No| C["Deny before route handler"]
 B -->|Yes| D{"Is account active and every enabled admission requirement met?"}
 D -->|No| E["Deny with inactive/admission error; keep pre-admission routes reachable"]
 D -->|Yes| F["Continue to host route"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["Host admissionMiddleware or AccountAdmission.require"] --> B["Check configured guard and current credential inside admission.current"]
 B --> C["Evaluate enabled domain, invitation and approval requirements"]
 C --> D{"active option and decision admit request?"}
 D -->|No| E["Throw UnverifiedEmailError or AdmissionRequiredError"]
 D -->|Yes| F["Return account/decision and continue host handler"]
```

**Code references:** [implementation](../src/admission/middleware.ts), [`tests/admission_gate.spec.ts`](../tests/admission_gate.spec.ts)
