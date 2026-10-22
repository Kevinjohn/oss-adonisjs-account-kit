# Add password reset to an existing Inertia React login

Keep the official AdonisJS 7 React starter's `/login`, `User` model, `web` guard, `/dashboard`
and styling. Add only password reset. “Keep your login” includes adapting its controller to
capture a credential revision; an unchanged session login cannot revoke older sessions.

First complete the mandatory [existing-application checklist](../guides/password-reset-existing-app.md),
including the [README installation instructions](../../README.md#installation), required peers,
Limiter setup and every generated migration. The setup schema is shared across capabilities;
`enabled: ['passwordReset']` does not generate a reset-only schema. See the
[session integration](sessions.md) for the guard contract.

The [hand-edit patch](patches/inertia-react-password-reset.patch) applies after configure to the
[pinned starter](../maintainers/verification.md#starter-baselines). It supplies
application controllers, validators, pages and session wiring; it contains no generated migration,
generated schema, dependency entry, lockfile or archive. Its handwritten `sessions` migration
belongs to the application and is separate from Account Kit's generated session registry.

## Preserve the native login and enforce revocation

Keep `app/controllers/session_controller.ts` and its routes. Its `store` still validates the
starter's email/password form and redirects to the existing dashboard, then delegates credential
establishment to `kit.authentication.login` with the existing `web` guard. The adapter in
`app/services/session_guard.ts` regenerates the session, calls `web.login`, and stores the returned
revision in `accountKitRevision`. It clears and regenerates the session on termination. The
starter signup controller keeps its validation and `User.create`, then uses the same credential
adapter for its automatic login, so the new revision check does not break signup.

Enable only `passwordReset` and select `authentication: { strategy: 'session', guard: 'web',
canAccess: async () => true }` in `config/account_kit.ts`; replace the permissive callback with
the application's real restriction policy. The no-op credential callback is deliberate only
because this application has no additional credentials. Revoke additional API keys or remember-me
credentials transactionally if the application uses them.

**Mandatory:** set `SESSION_DRIVER=database`, apply the handwritten `sessions` migration, and run
all generated migrations. The patch refuses the cookie store. A shared server-side store is
required in production; this recipe exercises SQLite-backed sessions locally. Existing sessions
without `accountKitRevision` must sign in again.

The router middleware order is body parser, session, Shield, Auth initialization, native silent
authentication, then `session_revision_middleware`. The revision middleware calls
`kit.authentication.current` for the authenticated user, passes the saved revision (including an
explicit null before the first change), and terminates missing/stale sessions. The native auth
middleware subsequently redirects protected requests to `/login`. Put proof-response headers in
the early server stack so proof failures also receive `Cache-Control: no-store` and
`Referrer-Policy: same-origin`. Exclude proof URLs from access logs, analytics and error reports.

## Controllers, pages and forms

The patch adds these application-owned routes without moving the starter routes:

| Method     | Path                     | Purpose                                                           |
| ---------- | ------------------------ | ----------------------------------------------------------------- |
| GET / POST | `/forgot-password`       | Guest form and generic request acknowledgement                    |
| GET        | `/reset-password/:token` | Inspect without consumption and render valid/invalid proof page   |
| POST       | `/reset-password/:token` | Validate confirmation, consume proof and redirect to native login |

The forgot form is guest-only; reset inspection and completion remain public, including for a
signed-in browser. The controller never uses submitted user IDs as authority. It catches committed
delivery failures without claiming recipient delivery and keeps known/unknown request feedback
identical. Invalid proof submissions return useful application flash feedback and the invalid
page offers a fresh-link action. Throttling gets retry guidance through the exception handler.

`urls.passwordReset` points to the application-owned `/reset-password/:token` page. The sample
configuration uses development log notifications, which refuse production; connect real delivery
before deploying. The acceptance spec replaces those callbacks with local capture.

`inertia/pages/auth/forgot_password.tsx` and `reset_password.tsx` reuse `AuthLayout`, the native
`auth__*`, `field__*` and `btn` classes, and the starter's typed Inertia `Form`/`Link` components.
The login page gains one forgot-password link. The starter Inertia middleware already shares
validation errors and flash messages, so its existing toast and theme remain in place.

Shield stays enabled. Forms use the native Inertia/Shield CSRF integration; direct failure POSTs
in the acceptance spec also send the real browser's CSRF token. New passwords use the starter's
8–32-character validation, with confirmation matched server-side. Inspection never consumes the
proof or changes the browser identity. On successful reset, the current signed-in browser is
terminated and redirected to login; other sessions fail on their next protected request.

### Failed-submission password policy

Keep both password fields in the mounted reset form after a confirmation error, so the user can
correct the confirmation without retyping the new password. Do not store either value in session,
flash, logs, a URL or application persistence. A page navigation/reload creates empty inputs.
The error summary receives focus, links to the invalid field, and connects field feedback using
`aria-invalid` and `aria-describedby`. The reference app's
[form-error spec](../../examples/inertia-react/tests/browser/account_form_errors.spec.ts) checks
retention of both values and keyboard-accessible recovery.

## Failure and credential matrix

Every row is exercised by `React reset recipe preserves failed submissions and revokes both native
sessions` in the [committed acceptance spec](../../examples/inertia-react/tests/recipes/inertia-react-password-reset.spec.ts).
The spec signs two distinct native sessions in before reset and verifies each reaches the native
protected dashboard. “Unchanged” means byte-identical stored hash and successful protected
requests from both saved sessions, rather than a reset response or database token count.

| Case                    | Expected behavior and assertions                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Known / unknown request | Same visible generic acknowledgement; only known account emits captured proof                                       |
| Valid proof GET twice   | Both pages allow a new password; proof still completes later                                                        |
| Confirmation mismatch   | Field error; both entered values retained; hash and both sessions unchanged                                         |
| Malformed proof         | Invalid page and rejected POST; hash and both sessions unchanged                                                    |
| Expired proof           | Insert a past-expiry proof row; invalid page and rejected POST; hash and both sessions unchanged                    |
| Replacement link        | Inspect a fresh live proof, request replacement, reject prior proof; unchanged hash/sessions; replacement completes |
| Consumed proof          | Invalid page and rejected replay; new hash and two fresh successful sessions unchanged                              |
| Successful reset        | Both old sessions redirected to native login; old-password login fails; new-password login reaches dashboard        |

The reference app's [composed browser journey](../../examples/inertia-react/tests/browser/account_journeys.spec.ts)
also signs in two clients before reset, checks native redirects for each old session, and tries the
old and new passwords through `/login`.

## Clean application check

Implementation is prepared; the full React harness and reference suite results are pending.
Do not treat the API harness evidence as React acceptance.

From the repository root, use the pinned-starter harness with a supplied archive:

```sh
pnpm test:recipe -- --recipe=inertia-react-password-reset \
  --candidate-tarball=<archive-path> --candidate-revision=<source-commit>
```

The harness checks the original login with the native cookie store before installing Account Kit.
After applying the patch and handwritten session migration, it switches to `SESSION_DRIVER=database`
and retains that setting for the printed replay command. The copied spec runs in the browser suite
with the starter's existing Chromium tooling; no second browser platform is added.

For the mutation check, remove `credentials_changed_at` advancement in the installed package's
`advanceCredentialRevision` implementation, rerun the retained command, and require a protected
old-session assertion to fail. Restore exact bytes from the supplied archive and rerun to green.
The final record must include source revision, archive digest, starter baseline and lock digest,
Node/pnpm/AdonisJS/database versions, exact commands, named results and mutation/restoration results.

The prepared application uses the pinned React starter at
`46d235932e3eb6472a16b740fa0b47b5f69fc6fc`, with original login evidence recorded in the
[starter verification record](../maintainers/verification.md). Planned coverage is local SQLite,
Chromium and local notification capture. No recipient delivery, PostgreSQL, other browser engine,
manual viewport or keyboard sign-off is claimed.
