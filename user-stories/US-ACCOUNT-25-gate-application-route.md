# US-ACCOUNT-25 — Gate a protected route by admission

As an application developer, I want to require admission before protected application data so that I can prevent non-admitted credentials from entering protected routes.

**Status:** Current when admission is installed and app applies middleware
**Access:** Host chooses guarded routes and keeps pre-admission status/sign-out routes reachable.
**Entry:** Host applies `AdmissionMiddleware` or calls `admission.require` in its own middleware/controller.
**Documentation:** [admission.md](../docs/guide/admission.md)
**Source:** [`src/admission/middleware.ts`](../src/admission/middleware.ts)
**Coverage:** [`tests/admission_gate.spec.ts`](../tests/admission_gate.spec.ts)

## Acceptance criteria

- `new AdmissionMiddleware({ admission, guard, active? })` resolves admission, checks the selected guard's name and strategy, and passes the credential evidence from `guard.current(context)` to `require`. The managed session and access-token adapters both authenticate and make the selected guard available to downstream application code.
- `AccountAdmission.require(input, { active? } = {})` evaluates current credentials and admission as in [US-ACCOUNT-56](US-ACCOUNT-56-read-current-admission-status.md). It then refuses an inactive account unless `active: false`, and refuses any unmet enabled requirement with `E_ACCOUNT_KIT_ADMISSION_REQUIRED` carrying the decision. A direct caller receives `{ account, decision }`; middleware continues to the host handler.

## User flow

```mermaid
flowchart TD
 A["Request reaches host-protected route"] --> B{"Does selected guard credential/revision validate?"}
 B -->|No| C["Deny before route handler"]
 B -->|Yes| D{"Was active:false explicitly selected?"}
 D -->|No| E{"Is account active?"}
 E -->|No| F["Deny inactive account; keep verification routes reachable"]
 E -->|Yes| G{"Are all enabled admission requirements met?"}
 D -->|Yes| G
 G -->|No| H["Deny with admission error; keep pre-admission routes reachable"]
 G -->|Yes| I["Continue to host route"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

The runnable API example traces the controller and middleware entry in its [admission code flow](../examples/api/README.md#admission-code-flow).

```mermaid
flowchart TD
 A["AdmissionMiddleware resolves admission and calls kit.managedHttp.assertGuard"] --> B{"Guard matches configured name and strategy?"}
 B -->|No| X["Throw guard configuration error"]
 B -->|Yes| C{"Which guard.current implementation did the host supply?"}
 C -->|Package session adapter| D["Authenticate selected guard, mark auth and read revision and optional handle"]
 C -->|Package access-token adapter| E["Authenticate selected guard, mark auth and read token identifier"]
 C -->|Host adapter| T["Host guard authenticates and returns current credential evidence"]
 D --> Q{"guard.current succeeds?"}
 E --> Q
 T --> Q
 Q -->|No| Z["Propagate guard refusal"]
 Q -->|Yes| F["AccountAdmission.require(input, options)"]
 S["Direct host caller supplies credential evidence"] --> F
 F --> G["Await AccountAdmission.current as traced in US-ACCOUNT-56"]
 G --> H{"Current succeeds?"}
 H -->|No| Y["Propagate credential or configuration error"]
 H -->|Yes| I{"Activation required and account inactive?"}
 I -->|Yes| J["Throw E_ACCOUNT_KIT_UNVERIFIED_EMAIL"]
 I -->|No| K{"Decision admitted?"}
 K -->|No| L["Throw E_ACCOUNT_KIT_ADMISSION_REQUIRED with decision"]
 K -->|Yes| M["Return account and decision"]
 M -->|Middleware| N["Return next()"]
 M -->|Direct caller| O["Host receives account and decision"]
```

**Code references:** [implementation](../src/admission/middleware.ts), [`tests/admission_gate.spec.ts`](../tests/admission_gate.spec.ts), [require](../src/admission/service.ts), [current credential trace](US-ACCOUNT-56-read-current-admission-status.md#code-flow), [session guard adapter](../src/http/managed_session_guard.ts), [access-token guard adapter](../src/http/managed_token_guard.ts), [guard configuration check](../src/managed_http_service.ts)
