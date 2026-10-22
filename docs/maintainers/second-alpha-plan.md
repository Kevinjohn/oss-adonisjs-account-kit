# Second alpha: existing-application adoption

Status: consensus draft, ready to split into GitHub issues. Prepared 22 October 2026 and revised
the same day after one adversarial review each by Fable 5.1, Opus 5.5 and GPT-6.1-Sol, then one
consensus round by Opus 5.5 and GPT-6.1-Sol. The reviews and briefs are the
`docs/reviews/2026-10-22-second-alpha-plan-*.md` files; that directory is gitignored, so keep local
copies. This document plans the selected work; it does not authorize implementation, merging or
release publication.

## Outcome and boundaries

An existing AdonisJS 7 user can add password reset to a working application, understand every
required change, exercise recovery paths, and prove that older credentials stop working. The
second alpha improves adoption and evidence without adding package capabilities.

- Preserve the application's existing login route, user model, route namespaces, guard choice and
  policies. Session stacks still need the documented login-controller edit (store the credential
  revision), the revision-check middleware and a server-side session store; see
  [sessions](../recipes/sessions.md). "Keep your login" means the route and model stay, not that
  the login controller is untouched.
- Reuse the four reference applications, their transplant and copy maps, the
  [acceptance guide](../guides/example-acceptance.md) and existing test helpers.
- Keep language, validation, authorization, presentation and delivery application-owned.
- The item numbers (1–4, 7–14, 31) are the owner's selection numbers from the original request.
  Items 5, 6 and 15–30 were not selected; do not look for them. Issues below use `I` numbers.
- Items 12 and 13 are assessments. A documented existing path can satisfy them.
- New feature work, broad audits, additional permanent applications, new platform support and
  hosted CI expansion are out of scope. A correctness defect that blocks an acceptance criterion
  gets a focused fix with a regression test in its own pull request; a material scope change
  returns for review.
- Every disposable "existing application" is scaffolded from the pinned official starter
  (procedure P1). A copy of `examples/api` or `pnpm test:consumer -- --prepare-only` is never an
  existing application: those apps already have Account Kit fully wired.
- Recipes link to the root README install section instead of copying an install command or a
  version URL.

## Decisions to record before dispatch

Record each decision as one line under this heading before the issue that needs it starts. The
default applies when the owner records nothing else.

Recorded 22 October 2026: the owner accepted the defaults for D1, D2, D3 and D4. Browser stacks
may record a labelled manual check where the P6 harness is not wired (P6). I2 still verifies the
D2 command form.

| ID  | Decision                                                                                                                                             | Default                                                                                                                                                                                                                                                                                                                                                            | Needed by |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| D1  | Distribution channel and next version.                                                                                                               | GitHub release tarball as for 0.1.1 (`README.md` install section); version `0.2.0`. The version is used only in I17.                                                                                                                                                                                                                                               | I3, I17   |
| D2  | Starter pins: `create-adonisjs` version and `adonisjs/starter-kits` revision.                                                                        | `pnpm create adonisjs@3.4.0 <dir> --kit=github:adonisjs/starter-kits/<kit>#46d235932e3eb6472a16b740fa0b47b5f69fc6fc --pkg=pnpm`, where `<kit>` is `api`, `inertia-react`, `inertia-vue`, `hypermedia` or `api-monorepo` (the directory names at that revision). The bare aliases (`api`, `react`, `vue`, `hypermedia`) download the default branch and do not pin. | I2        |
| D3  | Invitation recipe policy: reuse the admission-gated composition from `examples/api`, or document an owner-only application policy without admission. | Owner-only policy without admission, stored in an application-owned role column or table the recipe names.                                                                                                                                                                                                                                                         | I10       |
| D4  | Canonical guide file name.                                                                                                                           | `docs/guides/password-reset-existing-app.md`.                                                                                                                                                                                                                                                                                                                      | I4        |

## Shared procedures

Issues reference these by letter. Do not restate them inside an issue; link here.

**P1 Pinned disposable starter.** Run the D2 command into a directory outside the repository. The
scaffolder runs `git init` only, so commit the baseline first: `git add -A && git commit -m starter`.
Record the command, the `create-adonisjs` version, the starter revision, the generated
`package.json` dependency versions and the lockfile SHA-256. Before adding Account Kit, confirm
the starter's own login works: sign in through its login route and request one route behind its
auth middleware. For session kits, record the session store from `config/session.ts`; if it is
the cookie store, the recipe must include the switch to a server-side store. Patches are
`git diff <starter commit>`; the generated-file inventory is `git status --porcelain` after
`node ace configure adonisjs-account-kit`.

**P2 Archive.** During I2–I14, install the development archive produced by `pnpm build && pnpm pack`
at the current revision; record the source revision and the archive SHA-256 in the evidence.
During I17, pack once after the version and changelog are final, record the digest, pass the
archive path as `--candidate-tarball` and its source SHA as `--candidate-revision` to every
`pnpm test:consumer` and `pnpm test:recipe` run, and copy the same file to
`examples/<stack>/vendor/adonisjs-account-kit.tgz` for the browser examples (`pnpm install`,
`pnpm test`; do not run `kit:pack`). Verify the digest is unchanged after every step. Evidence
captured against a development archive is labelled as such.

**P3 Evidence record.** Each recipe gets a `## Clean application check` section with: source
revision, archive digest, P1 record, Node/pnpm/AdonisJS versions, database, notification mode,
exact commands, named test results and limits, in the form the
[acceptance guide](../guides/example-acceptance.md#updating-the-record) requires. A check an
agent did not run through P6 is labelled "manual check". Label local notification capture as
such; claim no recipient delivery and no PostgreSQL coverage for examples.

**P4 Documentation checks.** Run with Node 24 from the repository root:

```sh
pnpm quick:test --files=docs_links.spec.ts --files=docs_snippets.spec.ts --files=docs_reference.spec.ts --files=docs_spec_references.spec.ts
pnpm docs:build
pnpm exec prettier --check <changed files>
```

`docs_links` checks relative links and their heading anchors across tracked Markdown, including
the root and example READMEs. `pnpm docs:build` covers the rendered site under `docs/`.

**P5 File ownership.** Only I15 edits `docs/.vitepress/navigation.mts`, `docs/recipes/index.md`,
`docs/guides/adoption-paths.md`, `docs/README.md` and the root `README.md` navigation table. Only
I16 edits the tables in `docs/guides/example-acceptance.md` and `examples/README.md`, and its
first pass lands before any recipe issue starts. A recipe issue adds its own files plus at most
one link line in its own stack's example README. Only I10 and I12 edit
`examples/api/tests/functional/account_invitations.spec.ts`; I12's invitation child issue needs
I10, and I12 children that touch one suite run one at a time. Only I5 creates
`scripts/recipes/check.mjs`; I7, I8 and I9 may extend it one at a time, in that order. I13 and
I14 append their outcome lines to this file; rebase before pushing.

**P6 Recipe acceptance harness.**
`scripts/recipes/check.mjs --recipe=<name> [--database=sqlite] [--candidate-tarball=<file> --candidate-revision=<rev>]`
performs: P1 scaffold for the recipe's stack, baseline commit, install of the supplied candidate
archive (or a P2 development pack when no candidate is given, never a repack of a supplied one),
`node ace configure adonisjs-account-kit`, apply the recipe's committed patch
`docs/recipes/patches/<name>.patch` (hand edits only: no generated files, no `pnpm-lock.yaml`, no
archive dependency line), copy the recipe's committed spec from
`examples/<stack>/tests/recipes/<name>.spec.ts` into the scaffold's `tests/functional/` (API) or
`tests/browser/` (browser kits), install the spec's test dependencies, run that one spec, print the
P3 fields, and print the retained scaffold path and the exact spec command. The `tests/recipes/`
folder is outside the example suite globs on purpose; `tsconfig.json` and lint still cover it.
Recipe names are `<stack>-<capability>`: `api-password-reset`, `inertia-react-password-reset`,
`inertia-vue-password-reset`, `hypermedia-password-reset`, `invitations-existing-app` (API). P6 is
the one tooling addition in this plan: built for the API kit in I5, extended per browser stack
only where Playwright runs in the scaffold without new tooling; otherwise that stack's issue
records a labelled manual check (P3).

**P7 Mutation check.** After a green P6 run, in the retained scaffold apply the mutation the
recipe names to the installed package under `node_modules`, run the printed spec command directly
and require an assertion failure, restore the archive (`pnpm install --force` or re-copy), and
rerun to green. Record both outcomes.

**P8 Expired proof.** No clock injection exists. Insert a proof row with a past `expires_at`, as
`examples/inertia-react/tests/functional/reset_proof_journey.spec.ts` does.

**P9 Credential proof contract.** Two clients sign in through the starter's original login route
and each succeeds on the same starter-protected route before reset. After reset, each old
credential is rejected on that route (bearer `401`; session: the native redirect to login), the
old password fails and the new password succeeds through the original login route. A reset
success response or a database-row assertion never satisfies this.

## Issues

Each issue is self-contained for an agent working without supervision. "Done when" lists only
checks the agent can run or observe. "Owns" lists the files the issue may edit beyond new files.

### I1 Programme issue

- **Covers:** all items. Pinned; links every issue below and this document. No code.
- **Done when:** labels `wave:3` and `wave:4` exist; every issue below exists with its
  prerequisites and labels (`programme`, `wave:N`, `documentation`, `enhancement`, `decision` as
  applicable).

### I2 Record the decisions and verify the starter pin

- **Covers:** D1–D4.
- **Needs:** nothing.
- **Owns:** this file's decision table.
- **Do:** scaffold each of the four kits once with the D2 command and run the P1 login check.
- **Done when:** each of D1–D4 has a recorded value or the default marked "accepted"; the four P1
  records (command, versions, lockfile digest, session store, login check) are appended under this
  heading. If the `#<sha>` form is rejected by the scaffolder, record the alternative that
  reproduces the revision (for example `giget` of the subdirectory at that SHA) and update D2.

### I3 Reconcile release and install descriptions

- **Covers:** the "release descriptions disagree" prerequisite.
- **Needs:** I2 (D1).
- **Owns:** `examples/README.md` package-availability text, `docs/compatibility.md`,
  `docs/getting-started.md`, `docs/guides/core-api.md`, `examples/api/README.md`,
  `examples/inertia-react/README.md`, `examples/inertia-vue/README.md`,
  `examples/hypermedia/README.md`, `docs/recipes/password-reset-existing-login.md` install lines.
- **Do:** replace every present-tense statement that the package is `0.0.0`, unpublished,
  release-blocked or has no matching release with a link to the root README install section,
  distinguishing the available GitHub tarball from the not-yet-available npm publication. Keep
  dated historical evidence lines. Replace `node ace add adonisjs-account-kit` as a present-tense
  instruction with that link.
- **Done when:** every hit of
  `git grep -n -e 'no matching publi' -e 'manifest.*0\.0\.0' -e 'version is .0\.0\.0' -e 'unpublished .0\.0\.0' -e 'release-blocked' -e 'node ace add adonisjs-account-kit' -- README.md docs examples ':!docs/maintainers/second-alpha-plan.md' ':!docs/reviews'`
  is a dated evidence line or a statement conditional on npm publication; P4 passes.

### I4 Canonical reset-only integration guide and ownership table (items 2, 3)

- **Needs:** I2, I3.
- **Owns:** new D4 file; the responsibility sentence in `README.md` (replace with a link);
  `docs/recipes/password-reset-existing-login.md` (link to the guide, keep it token-specific).
- **Do:** write the one checklist every reset recipe links to: supported starting app (P1),
  install (link), required peers, `node ace configure` output, every migration and column the
  setup generates with the shared prerequisites named (run the setup in a P1 scaffold and paste the
  `git status --porcelain` inventory; do not imply a reset-only schema), `config/account_kit.ts`
  with `enabled: ['passwordReset']`, proof URLs, mail or log notifications, guard and revocation
  integration per guard type (token: package deletes tokens; session: revision store, middleware,
  server-side store), routes, error handling, verification. Mark each step mandatory or optional.
  Add one package/application responsibility table: transactions, proofs and credential lifecycle
  on the package side; guard wiring, validation, authorization, UI, language and delivery on the
  application side; existing protected routes need the revocation integration.
- **Done when:** the schema inventory equals the P1 `git status --porcelain` output of the
  scaffold after configure; the responsibility table heading appears exactly once in the
  repository (`git grep -c`); P4 passes.

### I5 Committed API recipe acceptance and harness (items 8, 9, 10 for the API)

- **Needs:** I4.
- **Owns:** new `scripts/recipes/check.mjs`, new `docs/recipes/patches/api-password-reset.patch`,
  new `examples/api/tests/recipes/api-password-reset.spec.ts`, the verification section of
  `docs/recipes/password-reset-existing-login.md`, `package.json` script
  `test:recipe` (`node scripts/recipes/check.mjs`).
- **Do:** apply the recipe to a P1 API scaffold by hand, export the hand edits as the patch, write
  the spec, build P6 for the API kit. The spec asserts P9 plus: the reset request returns the same
  generic acknowledgement for known and unknown addresses; GET proof inspection twice does not
  consume; malformed, expired (P8), consumed and mismatched submissions each fail and leave the
  stored password hash and both credentials unchanged; requesting a replacement proof makes the
  previous proof fail without changing the password or credentials, and the replacement completes;
  `node ace list:routes` shows only reset routes under the mount prefix.
- **Done when:** `pnpm test:recipe -- --recipe=api-password-reset` exits 0; P7 with
  credential-revision advancement removed and access-token deletion skipped fails, then passes
  again after restore; the recipe's P3 section is written; `pnpm lint`, `pnpm typecheck` and P4
  pass.

### I6 Annotated before/after diff for the API starter (item 4)

- **Needs:** I5.
- **Owns:** new `docs/guides/password-reset-starter-diff.md`.
- **Do:** render the I5 patch plus the generated-file inventory as an annotated guide grouped into
  generated files, hand edits and application choices, linking browser differences to I7–I9
  rather than copying them. Record the P1 fields.
- **Done when:** every file in the guide's inventory appears in the patch or the generated-file
  inventory and vice versa (diff the lists); `pnpm docs:build` renders the page; P4 passes.

### I7 React reset recipe with recovery and revocation (items 7, 8, 9, 10 for React)

- **Needs:** I4, I5, I16 first pass.
- **Owns:** `docs/recipes/inertia-react.md` (rewrite in place into the existing-app reset recipe;
  same URL and navigation entry), new patch and spec per P6,
  `examples/inertia-react/tests/browser/account_journeys.spec.ts`,
  `examples/inertia-react/tests/browser/account_form_errors.spec.ts`, one link line in
  `examples/inertia-react/README.md`, `scripts/recipes/check.mjs` only to add the kit.
- **Do:** state shared prerequisites by link, then the React-specific controllers, pages, forms,
  validation, CSRF, proof pages, redirects and errors, the login-controller revision edit, the
  session store requirement and middleware order. Document and test the password-retention policy
  on failed submission (the example currently keeps the entered password in
  `account_form_errors.spec.ts`). Extend `account_journeys.spec.ts` to the full P9 contract (it
  already proves other-session revocation; add the second pre-reset client and the old-password
  login failure). Give the recipe a failure matrix (malformed, expired, consumed, mismatched,
  replacement link, unchanged credentials after each failure) naming a test per row.
- **Done when:** `pnpm test` in `examples/inertia-react` passes including the edited specs;
  `pnpm test:recipe -- --recipe=inertia-react-password-reset` exits 0, or the P3 section records a
  labelled manual check that applied the patch to a P1 scaffold and ran the P9 contract; P4
  passes.

### I8 Vue reset recipe with recovery and revocation (items 7, 8, 9, 10 for Vue)

- **Needs:** I4, I5, I16 first pass, I7 (for `check.mjs` edits only). Same shape as I7.
- **Owns:** new `docs/recipes/inertia-vue.md`, new patch and spec per P6,
  `examples/inertia-vue/tests/browser/account_journeys.spec.ts`,
  `examples/inertia-vue/tests/browser/account_form_errors.spec.ts`, one link line in
  `examples/inertia-vue/README.md`, `scripts/recipes/check.mjs` only to add the kit.
- **Done when:** as I7 for `examples/inertia-vue` and `inertia-vue-password-reset`.

### I9 Edge reset recipe with recovery and revocation (items 7, 8, 9, 10 for Edge)

- **Needs:** I4, I5, I16 first pass, I8 (for `check.mjs` edits only). Same shape as I7, with
  native forms and the no-JavaScript baseline.
- **Owns:** new `docs/recipes/hypermedia-edge.md`, new patch and spec per P6,
  `examples/hypermedia/tests/browser/account_journey.spec.ts`, one link line in
  `examples/hypermedia/README.md`, `scripts/recipes/check.mjs` only to add the kit.
- **Do (in addition):** add the missing expired reset-proof case (P8); the suite currently covers
  expired verification only.
- **Done when:** as I7 for `examples/hypermedia` and `hypermedia-password-reset`, plus the
  expired-reset test fails when the expiry check is bypassed in the installed package under the
  example's `node_modules`, and passes again after the vendor archive is reinstalled.

### I10 Minimal invitation recipe and spec (item 11)

- **Needs:** I2 (D3), I4, I5.
- **Owns:** new `docs/recipes/invitations-existing-app.md`, new
  `docs/recipes/patches/invitations-existing-app.patch`, new
  `examples/api/tests/recipes/invitations-existing-app.spec.ts`;
  `examples/api/tests/functional/account_invitations.spec.ts` and
  `examples/api/app/services/account_kit_authorization.ts` only if D3 selects the existing
  admission-gated composition.
- **Do:** extract the recipe from `examples/api/app/controllers/invitations_controller.ts` and
  `account_kit_authorization.ts`; under the default D3 the patch adds the application-owned role
  storage and an owner-only policy with no admission dependency; give a file and copy map; no
  admin UI.
- **Done when:** the recipe spec runs against the D3 composition (under the default, an owner
  without admission succeeds and `grantAdmittedOwner` is not used) and covers guest rejection on
  POST send, an authenticated actor whose token lacks the `invitations:create` ability, an actor
  without the role, forbidden escalation to `owner`, permitted send and acceptance with the
  expected access assignment, and replay rejection; each denial leaves account and access rows
  unchanged (assert row counts and values); `pnpm test:recipe -- --recipe=invitations-existing-app`
  exits 0; existing resend and revoke evidence is linked; P4 passes.

### I11 Failure-coverage inventory (item 31, assessment)

- **Needs:** nothing.
- **Owns:** a new table in `docs/maintainers/verification.md`.
- **Do:** for each of the three boundaries (failure before commit, callback failure after commit,
  dispatcher interruption and restart) and each of reset, password change, invitation and the API
  outbox, record the test file and name that proves it or "missing". Start from
  `tests/password_reset_request.spec.ts`, `examples/api/tests/functional/account_password_reset.spec.ts`,
  `account_password_change.spec.ts`, `account_invitations.spec.ts` and the outbox retry test named
  in `examples/api/README.md`.
- **Done when:** the table has no empty cell, every link resolves (P4), and each "missing" row is
  filed as a child issue of I12 with the boundary and the assertion it needs.

### I12 Close inventoried failure gaps (item 31, additions)

- **Needs:** I11; one child issue per missing row; the invitation child also needs I10.
- **Owns:** the named existing suites; shared helpers only when two suites reuse them.
- **Do:** add only the missing cases with explicit barriers or hooks and persisted state. Pre-commit
  failure leaves credential, proof and application writes unchanged; post-commit failure keeps the
  committed change and the documented error semantics; a thrown dispatcher callback proves retry,
  not process-restart recovery or exactly-once delivery, and the table says so. No package worker,
  queue or durable receiver.
- **Done when:** each new test fails with its guard removed; package cases pass under
  `pnpm quick:test` and `pnpm test:pg`; API consumer cases pass under
  `pnpm test:consumer -- --database=sqlite` and `--database=postgres`; example-only cases are
  labelled SQLite.

### I13 Tuyau assessment (item 12)

- **Needs:** I5.
- **Owns:** a dated "I13 outcome" line in this file; one new file under
  `examples/inertia-react/inertia/` for the type check (both outcomes); `inertia/client.ts` and the
  reset page only if outcome B.
- **Do:** against the pinned official API-client guide revision (record the URL and date), check
  whether an application-owned reset route in `examples/inertia-react` already gives an inferred
  request and response type and a typed validation error in the client. Outcome A: link the
  existing files and record the check. Outcome B: add the smallest typed call for that one route.
- **Done when (either outcome):** `pnpm typecheck` in the example passes with one
  `@ts-expect-error` line in the named file that sends an invalid payload type to the reset route,
  and a named test exercises the runtime validation-error path; the outcome line names the files
  and commands. Dynamic managed routes get no inferred-contract claim.

### I14 API-monorepo assessment (item 13)

- **Needs:** I2, I5.
- **Owns:** a dated "I14 outcome" line in this file; a new short recipe only if outcome B.
- **Do:** scaffold `api-monorepo` with the D2 pin (the directory exists at that revision). Record
  the composition: workspace paths, selected guard, origins, frontend proof-page route and the
  backend install steps that differ from the API recipe. Outcome A: the API recipe plus the
  recorded differences suffice; link them. Outcome B: write the recipe section with only those
  differences.
- **Done when:** the outcome line exists; for B, the P9 contract runs in the disposable monorepo
  and its P3 record is written. No permanent application is added. Time box: one working session;
  an unfinished B is recorded as "deferred" with the open points listed.

### I15 Entry points, navigation and recipe index (items 1, 3 README part)

- **Needs:** I6–I10, I13, I14.
- **Owns:** `README.md` table and responsibility sentence, `docs/README.md`,
  `docs/.vitepress/navigation.mts`, `docs/recipes/index.md`, `docs/guides/adoption-paths.md`.
- **Do:** make "keep your login; add password reset" the first path on both landing pages; link
  the D4 guide, I6 diff and the four reset recipes; keep new-app examples as the secondary path.
- **Done when:** the first link after the heading "Choose your stack and starting point" in both
  `README.md` and `docs/README.md` targets the D4 guide, and each row of the "Existing
  application" column targets that stack's reset recipe; every recipe from I5–I10 appears once in
  `navigation.mts` and `docs/recipes/index.md`; P4 passes.

### I16 Example evidence format and final record (item 14)

- **Needs:** I3 for the first pass; I7–I14 for the final pass.
- **Owns:** `examples/README.md` tables, the `## Checks and evidence` section of each example
  README, the tables in `docs/guides/example-acceptance.md`.
- **Do:** first pass (wave 2, before any recipe issue starts): give each example README a purpose
  line, supported starting point and a `## Checks and evidence` section with the four columns of
  the acceptance guide (implemented, automated HTTP, browser, manual checks and limits). Final
  pass: fill in the I7–I14 results and the I13/I14 outcomes.
- **Done when:** all four READMEs have the section with those four columns; no row inherits a
  delivery, database or browser claim from another stack; P4 passes.

### I17 Candidate checks, changelog and release gate

- **Needs:** I15, I16 final pass; D1 recorded.
- **Owns:** `package.json` version field, `CHANGELOG.md`, `docs/maintainers/release-gate.md`,
  `docs/maintainers/verification.md` candidate section.
- **Do:** set the D1 version and write the changelog entry first; then pack once (P2); run the
  exit-criteria commands; record source revision, archive digest, runtime, package, starter and
  database versions, commands, outcomes and limits; check upgrade impact from 0.1.1 (changed
  generated files or migrations).
- **Done when:** every command below exits 0 with its output recorded and the archive digest
  unchanged throughout, or the failure is recorded and the candidate is declared not ready. Merge
  consent and publication remain owner actions. After publication, smoke-test the advertised
  install and record that separately.

## Delivery waves

| Wave | Issues                                        | Note                                                                                        |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | I1, I2, I11                                   | No prerequisites. I11 is a table only.                                                      |
| 2    | I3, I16 first pass, then I4, then I5, then I6 | Serial after I3; I16's first pass runs beside I4.                                           |
| 3    | I7, I8, I9, I10, I12, I13, I14                | Parallel after I5 (I10 after D3; I12 after I11; `check.mjs` edits in the order I7, I8, I9). |
| 4    | I15, then I16 final pass, then I17            | Serial; one integration owner, no concurrent navigation edits.                              |

## Owner manual checks

These are not part of any issue's done criteria. The owner performs and records them in I16 or
I17: visual inspection of the landing pages, recipes and diff guide at desktop and narrow widths;
keyboard-only error recovery in each browser example; the Edge walkthrough with JavaScript
disabled where no spec covers a step.

## Candidate exit criteria (I17)

Run from the repository root with Node 24 and pnpm, after one P2 pack:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm quick:test
pnpm test:built-exports
pnpm test:built-setup
pnpm test:pg-service
pnpm test:pg
pnpm test:adapter
pnpm test:consumer -- --database=sqlite --candidate-tarball=<file> --candidate-revision=<rev>
pnpm test:consumer -- --database=postgres --candidate-tarball=<file> --candidate-revision=<rev>
pnpm test:consumer -- --mode=minimum --compatibility=minimum --database=sqlite --candidate-tarball=<file> --candidate-revision=<rev>
pnpm test:consumer -- --mode=minimum --compatibility=minimum --database=postgres --candidate-tarball=<file> --candidate-revision=<rev>
pnpm test:consumer -- --mode=service-only --database=sqlite --candidate-tarball=<file> --candidate-revision=<rev>
pnpm test:consumer -- --mode=service-only --database=postgres --candidate-tarball=<file> --candidate-revision=<rev>
pnpm test:recipe -- --recipe=api-password-reset --candidate-tarball=<file> --candidate-revision=<rev>
pnpm test:recipe -- --recipe=invitations-existing-app --candidate-tarball=<file> --candidate-revision=<rev>
pnpm docs:build
```

Then run `pnpm test:recipe` for each browser recipe that I7–I9 wired into the harness, with the
same candidate flags; for a stack recorded as a manual check, repeat that manual check against the
candidate archive and record it. Then, in each changed example with the candidate archive copied
to its `vendor/` path: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`.
Record the archive digest with every result. Retain valid existing compatibility evidence where
the change does not invalidate it.

The review decision is whether this bounded adoption-and-evidence scope defines the second alpha.
No package feature addition is proposed; the only tooling addition is the P6 harness.
