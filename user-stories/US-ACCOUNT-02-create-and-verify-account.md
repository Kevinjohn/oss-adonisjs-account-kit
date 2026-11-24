# US-ACCOUNT-02 — Register an account

As a prospective account holder, I want to register so that the application creates an account according to its signup policy.

**Status:** Current when `registration` is enabled and its availability allows signup
**Access:** The opt-in `registration` capability must be listed in `enabled` (it is off by default; the generated config enables it). Signup availability is `open`, `closed`, or `application`; `closed` throws `E_ACCOUNT_KIT_AUTHORIZATION`, and the host owns the application-mode decision and field mapping. The managed `auth.signup` route accepts only `open`.
**Entry:** Host calls `registration.register`, or mounts the managed public `auth.signup` route (`POST auth/signup`), which refuses unless availability is `open` (so `application` mode is refused) and then attempts to sign the person in with the same credentials; verification is the separate action in [US-ACCOUNT-38](US-ACCOUNT-38-complete-email-verification.md).
**Documentation:** [registration.md](../docs/guide/registration.md)
**Source:** [`src/registration.ts`](../src/registration.ts)
**Coverage:** [`tests/registration.spec.ts`](../tests/registration.spec.ts), [`tests/registration_claim.spec.ts`](../tests/registration_claim.spec.ts)

## Acceptance criteria

- **Inputs and result:** `registration.register({ email, password, registrationData? })` returns the created account when `registration` is enabled; a disabled capability throws `E_ACCOUNT_KIT_CAPABILITY_DISABLED`, and a taken address throws `E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED`. `registrationData` is untrusted and is passed through configured `registration.mapFields`; availability and password rules come from config.
- **Managed `auth.signup`:** after a successful `register`, or a reported committed registration follow-up failure, the handler attempts a login. When it succeeds the 201 response carries the represented account and, for an access-token guard, a bearer token; when the login fails the response is `registered: true, authenticated: false` and the account still exists. A direct service call may surface a delivery or observer error after creation commits.
- Managed signup rate-limits by request IP before running the default email, [password fields](REFERENCE.md#managed-password-fields) and optional `registrationData` validator or the host replacement. The managed duplicate-email response is a 422 field error.

## User flow

```mermaid
flowchart TD
 A["Prospective account holder submits email, password and configured fields"] --> B{"Is registration enabled, and availability open or accepted by host application policy?"}
 B -->|No| C["Reject signup without creating an account"]
 B -->|Yes| D["Create inactive account and issue activation link"]
 D --> E["Managed signup attempts sign-in; receive signed-in state or confirmation of registration without authentication"]
```

## Code flow

```mermaid
flowchart TD
  A["Managed auth.signup asserts open signup, consumes IP budget, validates fields and checks password policy"] --> B["registration.register"]
  H["Host authorises application-mode signup and calls registration.register"] --> B
  B --> C["Capability gate; check availability, email, password and mapped fields"]
  C --> D["Transaction checks email uniqueness, creates inactive account and stores activation proof"]
  D --> E["Commit and run activation delivery and lifecycle event"]
  D -->|Duplicate email| DUP["Throw E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED; managed handler sends email field error"]
  E -->|Direct call| F["Return created account or propagate committed follow-up failure"]
  E -->|Managed; success or reported committed failure| G["Call authentication.login with same credentials"]
  G -->|Failure| NO["Return 201 with registered true and authenticated false"]
  G -->|Success| OK["Return 201 with represented account; access-token guard also supplies bearer token"]
```

**Code references:** [implementation](../src/registration.ts), [`managed signup handler`](../src/http/handlers_registration.ts), [`assertPublicRegistration`](../src/managed_http_service.ts), [`tests/registration.spec.ts`](../tests/registration.spec.ts), [`tests/registration_claim.spec.ts`](../tests/registration_claim.spec.ts)
