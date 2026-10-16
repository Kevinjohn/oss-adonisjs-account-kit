# Developer evaluation

## Configuration

This is the approved technical fallback for the final four-task evaluation. The preferred
three-to-five-developer study, including a participant new to AdonisJS, was not performed in this
run. The fallback follows the same task set and documentation-only guidance rule. It provides
technical walkthrough evidence; it does not establish human usability or participant success.

The walkthrough installed the candidate in a fresh conventional AdonisJS API starter using Node
`v24.21.0`, pnpm `11.23.0`, Adonis core `7.5.x`, Lucid `22.4.x`, SQLite via `better-sqlite3`, and
the starter's existing `api` access-token guard with its native access-token table. The evaluated
candidate source revision was `f4f067233ad5e96652d7ee0250ec125b0e0b8262`; its package archive had
SHA-256 `cc7976d8b1a485ffdae4ea149c2e0050d2e611b7a76d025554d276d4637ac9b7`. The archive digest
identifies the installed candidate. The walkthrough used fictional accounts and local-only proof
capture. PostgreSQL and SMTP were not used.

## How it works

The four tasks and observed results were:

1. **Configure a supported conventional application — passed.** The evaluator installed the
   candidate and the setup guide's required TypeScript version, registered the documented command
   loader, previewed the API-token setup, and applied it explicitly. The application and package
   migrations were reviewed and run explicitly; schema classes were regenerated and type checking
   passed. Generated routes were inert while application-route revocation was disabled. After
   verifying revocation on an application-owned route, setup was explicitly applied with
   `applicationRouteRevocation` enabled; managed routes then booted and served requests.
2. **Explain generated changes and application responsibilities — passed.** The final package-owned
   files were `config/account_kit.ts`, `config/account_kit_setup.json`, `.env.account-kit.example`,
   `app/services/account_kit_guard.ts`,
   `app/middleware/account_kit_access_middleware.ts`,
   `app/middleware/account_kit_proof_headers_middleware.ts`,
   `start/account_kit_routes.ts`, changes to `adonisrc.ts`, `start/kernel.ts`, and `start/routes.ts`,
   and eight account-kit migrations covering reset tokens, invitations, email changes, verification
   and credential-revision columns, transaction locking, identity-contract evolution, and retired
   email-change storage. The application retained its access policy, replacement-route validation
   and response mapping, public origins, production mail transport and delivery, proof landing
   pages, guard and token policy, and deployment checks. The walkthrough supplied a real
   `role_assignments`-based access policy, a private local capture callback, and temporary
   evaluation-only login, probe, and password-change routes; those temporary routes were not
   generated managed endpoints.
3. **Exercise the enabled account lifecycle over HTTP — passed.** Registration returned 201;
   activation inspection and completion returned 200. Managed login and protected profile returned 200. A reset request returned 202; proof inspection returned 200 with `Cache-Control: no-store`
   and `Referrer-Policy: no-referrer`; reset completion returned 200. The pre-reset token then
   returned 401, login with the new password and profile returned 200, logout returned 204, and
   replay of the ended token returned 401. Before enabling managed routes, an application-owned
   protected route returned 200 for a token, 401 for that same token after the public password
   change operation, and 200 for a fresh token.
4. **Replace one named endpoint and keep the other selected endpoints — passed.** The evaluator
   excluded `auth.passwordReset.request` in persisted `managedExcept` and implemented an
   application-owned `POST /api/v1/account-kit/auth/password-reset` handler. It validates the email,
   calls the public `kit.passwordReset.request({ email, clientKey })` operation, handles documented
   post-commit delivery errors without exposing them, and returns the generic acknowledgement.
   Preview omitted the selected endpoint while retaining the others. After explicit apply, setup
   check reported the persisted choice with `differences: []` and omitted the endpoint from its
   managed inventory. Login and profile still returned 200; the replacement returned 202 with the
   generic acknowledgement.

The walkthrough used the candidate README and maintained documentation and examples, plus the
official AdonisJS API starter and ordinary framework/package tooling. The relevant published
references were the [setup guide](setup.md), [managed HTTP contract](managed-http.md),
[notification guide](notifications.md), [application-owned integration guide](application-owned-integration.md),
and [API token example](../examples/api/TOKENS.md). No implementation source, build output,
declarations, private evaluation materials, or maintainer assistance supplied task steps.

## Files delta

This evaluation record adds no package runtime files. The installed setup generated the files listed
under task 2 in the disposable application. They are described here so application owners can
identify which changes belong to package setup and which responsibilities remain theirs.

## Manual steps and limits

- The setup check retained `workflowVerified: false`, `migrationsApplied: false`,
  `externalConfigured: false`, and `productionReady: false`, with migration state
  `generated-application-unknown`, even though the evaluator explicitly ran the migration command
  successfully. These are static report values, not runtime verification; this walkthrough does
  not treat them as proof that migrations were absent or that production readiness was established.
- Setup continued to report `APP_URL` as required for the two mail-origin fields although the
  disposable application's `.env` contained its loopback value and the application booted. The
  post-evaluation diagnosis confirmed that the setup origin validator reads the setup process
  environment and does not load `.env` for these origin checks. Operators should supply the selected origin variables to the setup command or
  verify the application's loaded values separately. The observed diagnostic was not evidence of
  an application boot failure.
- Local capture allowed proof inspection but did not send mail. No SMTP transport, recipient
  delivery, or production delivery readiness was demonstrated. Public origins, real transport,
  delivery worker/retry behavior, application guard and token policy, and deployment checks remain
  application responsibilities.
- PostgreSQL was not evaluated. No claim is made about PostgreSQL behavior from this walkthrough.
- No human participants were evaluated. There is no participant mix, human task-success result,
  usability finding, novice-success claim, setup-time measurement, or time guarantee.

The attempt record also retains these execution events:

- A zsh wrapper tried to assign its read-only `status` variable after the first preview. Its output
  was captured and a separately named preview completed with exit code 0; preview made no writes.
- The sandbox rejected the assigned HTTP listener with `EPERM`; the same app then started through
  the host-authorized execution route on the assigned localhost port.
- The first signup assertion expected 200 or 202 and exited on 201. The endpoint documentation
  specifies 201; the assertion was corrected to the documented status and the activation flow
  completed.
- A private response parser expected a `credential` key where login returned `token`. Only
  top-level key names and types were inspected; the parser was corrected and the protected request
  returned 200. No credential or proof value is included in this record.

These events are recorded as harness or execution corrections, not candidate failures or human
assistance. The fixed tasks passed using published documentation. The managed-mode documentation
inconsistency found during the walkthrough is resolved by the guide reconciliation in this change.
Product-owner review of origin diagnostics, migration-status reporting, and production delivery
integration remains outstanding. Local capture and the technical fallback do not replace those
reviews.

## Changelog

The Unreleased changelog records this technical evaluation and its limits.
