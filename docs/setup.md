# Account Kit setup

## Configuration

After installing the package, add `() => import('adonisjs-account-kit/commands')` to the application's `adonisrc.ts` `commands` array. Do this before running setup; the basic `configure` command creates its own starter config and is a separate path. Run `node ace account-kit:setup` for the interactive choices, or pass a versioned JSON file with `--input=path/to/choices.json`. Both paths produce the same typed setup choices. `--apply` writes the proposal; without it the command previews. `--check` reads the persisted choices and diagnoses the current application without writing. Add `--production` to check public origin and session security requirements for deployment.

The file `config/account_kit_setup.json` records the six pillars. `features` selects underlying account services; `managed` selects maintained endpoint groups and must be a subset of `features`. This allows an application-owned login alongside managed password reset. A single managed group uses one existing named `session` or `access_tokens` guard. Setup never creates a guard or changes the application's default guard. `routePrefix` identifies the managed route prefix. The supported identity mapping uses the default Lucid connection, an `id` primary key of integer, string, or UUID type, and the conventional `email`, `password`, and `email_verified_at` columns. Custom adapters require a separate contract review.

The `mail` pillar stores environment variable **names** for the sender, transport, trusted backend origin, and trusted frontend origin. The default selects maintained AdonisJS Mail; install and configure its provider and real transport explicitly. It stores safe relative paths for the relevant action destinations. It does not store origin or secret values. In production, public backend and frontend origins must use HTTPS. Development HTTP is limited to loopback origins. Origin base paths are retained. Mail delivery is either `best-effort` or application-owned `durable`; durable classification requires custom notification callbacks and an independently verified worker and retry path. A database commit and message delivery are separate outcomes.

The policy pillar records registration as `open`, `closed`, or `application`. Additional `registrationFields` each name an application-owned model property, a primitive type, whether it is required, and an optional string `maxLength`. Generated validation and mapping admit only those fields; protected account properties and unknown request fields are rejected. Password policy uses `minLength` (default 8), `maxLength` (default null), `letters`, `mixedCase`, `numbers`, `symbols` (all false), and `minScore` (default 0). Setup rejects limits above the service's 256-character ceiling or a maximum below the minimum. Login verification of existing passwords is independent of the new-password policy. Invitation permission and restricted-account hooks are application policies; setup blocks affected activation when they are missing.

Social identity is recorded separately. The default records it as not applicable because no provider is selected. A selected Google or GitHub provider is `approved-pending` until the social implementation is installed and verified. That status is not a readiness claim.

Setup flags control the operation, committed choices control runtime policy, and environment references supply deployment values. There is no remembered wizard state. Noninteractive setup requires `--input`; missing or unsupported fields produce a nonzero result with the field name. Unknown JSON fields are rejected so a secret cannot be silently persisted. `--retirement-maintenance-window` is only relevant when retiring password login and records the operator's assertion that credential changes are stopped during the transition.

## How it works

### The full plan appears before a write

Setup inspects package dependencies, named guards, database configuration, existing routes, generated migration names, and setup files without executing application code or reading secret values. The report lists all six pillar outcomes, file actions, endpoint names, prerequisites, diagnostics, migration state, delivery mode, and distinct readiness states. Existing installations also preview by default. A missing required package, differing generated file, route prefix collision, unsupported schema, or missing mandatory policy blocks `--apply` before any write. Install missing packages explicitly, resolve the named collision, and run setup again.

### A repeated run can recover from interruption

Every planned file is checked again immediately before it is created. Identical files are skipped. A partially completed run can be repeated with the same choices; completed steps are recognized, and remaining files are created once. Existing application files, environment files, and stored account data are not overwritten or deleted. Removing a managed login route while keeping its underlying authentication configuration is a route choice, not credential retirement. Removing the authentication configuration triggers `kit.authentication.retirementImpact({ passwordLogin: false })`, a read-only scan of configured user IDs and the user adapter's `hasPassword` truth. Setup reports the inspected and affected counts and blocks if any account would lose its last usable login. The owner must migrate those accounts to a confirmed alternative first. Even a zero count requires `--retirement-maintenance-window`; the scan is point-in-time and cannot protect a live application against concurrent credential changes. Social providers remain unavailable as alternatives until installed identity inventory can prove a confirmed, usable method. Preserved credential rows alone do not demonstrate access.

### Readiness is evidence, not a single setup flag

The report distinguishes generated configuration, valid configuration, applied migrations, external integrations, and verified workflows. The command does not claim production readiness from static inspection. A production check rejects insecure public origins and unverified session settings. It reports unresolved sender, destination, permission, guard, and revocation work by field name without printing the environment values.

## Files delta

- `config/account_kit_setup.json`: versioned six-pillar application choices.
- `config/account_kit.ts`: selected service capabilities, password and registration policy, trusted action URLs, and maintained Mail or explicit application notification callbacks. A differing existing config stops setup before any write.
- `start/account_kit_routes.ts`: explicit package-maintained route mount using the selected existing guard adapter. Setup adds one import to `start/routes.ts` without replacing its routes. Disabling the last managed group changes this owned file to an inert marker, so the retained import registers no endpoints.
- `app/services/account_kit_guard.ts` and `app/middleware/account_kit_access_middleware.ts`: the selected existing guard adapter and the same account access gate for application-owned protected routes.
- `adonisrc.ts` and `start/kernel.ts`: only missing required provider and middleware imports are added to their existing arrays; other entries are preserved.
- `.env.account-kit.example`: names of required deployment references with empty safe examples. Existing `.env` files and ignore rules are untouched.
- `database/migrations/*_account_kit_*.ts`: the package's reviewed schema migrations, rendered for the selected users table and identifier type. Existing same-name migrations must match; they are never rewritten.

## Manual steps

1. Explicitly install any reported missing packages with `pnpm add`. Setup does not install dependencies.
2. Review migration content and apply it with `node ace migration:run` during the chosen deployment window. Application startup does not run migrations.
3. Review the generated route mount and configure the selected guard's application model. Implement application-owned notification callbacks or configure maintained Mail. No application-authored controller is needed for an enabled managed endpoint.
4. Supply and validate deployment environment values, the user adapter and model contract, invitation permission, restricted-account policy, and any frontend pages that collect passwords or complete email actions. Attach the generated account access middleware to application-owned protected routes so credential revocation applies there as well. For a session guard, verify cookie security, CSRF bootstrap, trusted origin/proxy configuration, session storage and logout. For a token guard, verify issuance, lifetime, abilities, revocation and safe client storage.
5. Run `node ace account-kit:setup --check --production` after the application integration and exercise the selected workflows over HTTP. The command's static report cannot substitute for those end-to-end checks.

## Changelog

The Unreleased changelog records the new setup command and persisted setup contract.
