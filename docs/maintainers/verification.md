# Candidate verification

Validation uses Node 24 and pnpm. Dated candidate records below identify the revisions and
configurations tested; historical totals do not describe the latest candidate. Check each pull
request for its current automated workflow results.

## Checklist

Run from the checkout on Node 24 (`nvm use`). One line per gate; the link gives the detail and the
last recorded outcome. Record the exact source revision and archive SHA-256 with every result.

1. `pnpm lint`, `pnpm typecheck`, `pnpm build`: [source checks](#source-checks).
2. `pnpm quick:test`: the SQLite suite; [source checks](#source-checks).
3. `pnpm test:built-exports` and `pnpm test:built-setup`: the built package entry points and setup command; [source checks](#source-checks).
4. `pnpm test:pg-service`, then `pnpm test:pg`: PostgreSQL 16 lifecycle and the full suite; [local PostgreSQL package tests](#local-postgresql-package-tests).
5. `pnpm test:mysql` when a MySQL 8.4 server is available: [MySQL package tests](#mysql-package-tests).
6. `pnpm test:adapter` and `pnpm docs:build`: [source checks](#source-checks).
7. Pack one candidate archive and record its SHA-256; it must not change for the rest of the run: [identity and execution boundaries](#identity-and-execution-boundaries).
8. `pnpm test:consumer` for SQLite and PostgreSQL, in default, `minimum` and `service-only` modes: [reproducible checks](#reproducible-checks) and [packed consumers](#packed-consumers-and-fresh-recipe-transplants).
9. Install the same archive into each reference example and run its checks: [reference examples](#reference-examples-using-the-same-vendor-archive).
10. Confirm the failure-path evidence still holds on the candidate: [credential and invitation failure coverage](#credential-and-invitation-failure-coverage).
11. Record the upgrade impact against the last published package: [upgrade impact and final handoff](#upgrade-impact-and-final-handoff).
12. Hand the results to the [release gate](release-gate.md); merge, publication and manual checks stay owner actions.

## Reference

Dated candidate records and the detail behind each checklist line. Newest candidate first.

### Second alpha 0.2.0 candidate

Recorded 22 October 2026 for #642, after the #632 final evidence pass and #641 navigation work.
The required source, distribution, recipe and reference-example commands passed against one
archive. This is local candidate verification; merge, publication, manual checks outside the
automated suites and a fresh advertised-install smoke after publication remain owner actions.

#### Identity and execution boundaries

- Package: `adonisjs-account-kit@0.2.0`. Version and changelog were committed before packing.
- Archive: `/private/tmp/account-kit-642-candidate/adonisjs-account-kit-0.2.0.tgz`.
- Archive source (A): `1ef240c72c4445482baf8f30b806b9128550d811`.
- SHA-256: `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693`. It was packed once and was not replaced.
- Corrected test-source integration (B): `3babfbf3dc9bfa25aa2fccc8615b087bb5a4f26c`, incorporating the #636
  recipe-spec import correction `4f5023f6baf319f2fe180ea5fcda91ae0668851f`.
  At B, only the acceptance spec had changed after A; it is outside the package archive.
  The integrated correction record below identifies later documentation, patch and spec changes;
  package runtime and templates remain unchanged.
- Runtime: Node `24.21.0`, pnpm `11.23.0`. Root dependencies: AdonisJS Core `7.6.0`,
  Lucid `22.4.2`, Assembler `8.5.2`, Session `8.1.0`, Limiter `3.0.1`, TypeScript `5.9.3`,
  `better-sqlite3` `12.11.1` (SQLite `3.53.2`) and `pg` `8.23.1`.
- PostgreSQL: local `16.15`, port `55432`. `pnpm test:pg` owned its cluster lifecycle;
  a separate `pnpm pg:start` / `pnpm pg:stop` bracketed the sequential PostgreSQL consumers.
- Full command output and per-command JSON records are retained under
  `/private/tmp/account-kit-642-results/`. A table record key names both `<key>.log` and
  `<key>.json`; each JSON includes the command, working directory, start/end time, source and
  candidate revisions, exit status, runtime and archive hashes before and after execution.
  The digest in each row is the unchanged archive checked with that result.

The initial API `pnpm typecheck` exited 2 because the invitation acceptance spec statically imported
`#services/invitation_delivery`, a service supplied only by the transplant patch. The first fresh
SQLite consumer also exited 1 on that typecheck. Their records remain `example_api_typecheck` and
`consumer_fresh_sqlite`, both at A with the same unchanged digest above. The owning #636 fix loads
the patch-supplied capture inside the test through an explicitly typed runtime import. No test
exclusion or reference-app service was added. Independent review found no further findings; API
lint/typecheck/build/tests, a new fresh consumer and fresh invitation transplant then passed at B.

#### Source checks

Each row ran the corresponding repository script (`pnpm lint`, `pnpm typecheck`, `pnpm build`,
`pnpm quick:test`, `pnpm test:built-exports`, `pnpm test:built-setup`, `pnpm test:pg-service`,
`pnpm test:pg`, `pnpm test:adapter`, and `pnpm docs:build`). SQLite checks explicitly selected
`DB_CLIENT=better-sqlite3`.

| Output record        | Source | Outcome                                            | Archive SHA-256, unchanged                                         |
| -------------------- | ------ | -------------------------------------------------- | ------------------------------------------------------------------ |
| `lint`               | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `typecheck`          | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `build`              | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `quick_test`         | A      | 1,090 passed, 2 PostgreSQL-only skips; 32s; exit 0 | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `test_built-exports` | A      | 2 passed; 144ms; exit 0                            | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `test_built-setup`   | A      | 11 passed; 531ms; exit 0                           | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `test_pg-service`    | A      | 61 passed, no skips; 80.9s; exit 0                 | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `test_pg`            | A      | 1,089 passed, 3 SQLite-only skips; 33s; exit 0     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `test_adapter`       | A      | 8 passed; 225ms; exit 0                            | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `docs_build`         | A      | Passed; 4.20s; exit 0                              | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |

The SQLite skips cover PostgreSQL COMMIT rejection and UUID canonicalization. PostgreSQL skips
cover SQLite cleanup failure, corrupt-revision storage and integer token timestamps. The service
checks exercise their own PostgreSQL service lifecycle. The docs build reports its existing large
bundle warning; it exits successfully.

#### Packed consumers and fresh recipe transplants

These commands used the same two candidate arguments, without asking either harness to pack:

```sh
candidate=/private/tmp/account-kit-642-candidate/adonisjs-account-kit-0.2.0.tgz
revision=1ef240c72c4445482baf8f30b806b9128550d811
pnpm test:consumer -- --database=sqlite --candidate-tarball="$candidate" --candidate-revision="$revision"
pnpm test:consumer -- --database=postgres --candidate-tarball="$candidate" --candidate-revision="$revision"
pnpm test:consumer -- --database=sqlite --candidate-tarball="$candidate" --candidate-revision="$revision" --mode=minimum --compatibility=minimum
pnpm test:consumer -- --database=postgres --candidate-tarball="$candidate" --candidate-revision="$revision" --mode=minimum --compatibility=minimum
pnpm test:consumer -- --database=sqlite --candidate-tarball="$candidate" --candidate-revision="$revision" --mode=service-only
pnpm test:consumer -- --database=postgres --candidate-tarball="$candidate" --candidate-revision="$revision" --mode=service-only
pnpm test:recipe -- --recipe=api-password-reset --candidate-tarball="$candidate" --candidate-revision="$revision"
pnpm test:recipe -- --recipe=invitations-existing-app --candidate-tarball="$candidate" --candidate-revision="$revision"
pnpm test:recipe -- --recipe=inertia-react-password-reset --candidate-tarball="$candidate" --candidate-revision="$revision"
pnpm test:recipe -- --recipe=inertia-vue-password-reset --candidate-tarball="$candidate" --candidate-revision="$revision"
pnpm test:recipe -- --recipe=hypermedia-password-reset --candidate-tarball="$candidate" --candidate-revision="$revision"
```

| Output record                                    | Source | Outcome                                                                   | Archive SHA-256, unchanged                                         |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `consumer_fresh_sqlite_recipe_import_fix`        | B      | Harness passed; exit 0                                                    | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `consumer_fresh_postgres`                        | B      | Harness passed; exit 0                                                    | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `consumer_minimum_sqlite_recipe_import_fix`      | B      | Harness passed; exit 0                                                    | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `consumer_minimum_postgres`                      | B      | Harness passed; exit 0                                                    | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `consumer_service-only_sqlite_recipe_import_fix` | B      | Harness passed; exit 0                                                    | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `consumer_service-only_postgres`                 | B      | Harness passed; exit 0                                                    | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_api-password-reset`                      | A      | Fresh pinned starter, original login and recipe acceptance passed; exit 0 | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_invitations-existing-app`                | B      | Fresh pinned starter, original login and recipe acceptance passed; exit 0 | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_inertia-react-password-reset`            | A      | Fresh pinned starter, original login and recipe acceptance passed; exit 0 | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_inertia-vue-password-reset`              | B      | Fresh pinned starter, original login and recipe acceptance passed; exit 0 | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_hypermedia-password-reset`               | B      | Fresh pinned starter, original login and recipe acceptance passed; exit 0 | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |

The full fresh-mode consumers exercise generated configuration, migration idempotency, bearer-token and
server-side session integration, admission and release scenarios. Their intentional rejection of
cookie-only session storage is a passing negative check. Minimum mode verifies the declared peer
floor; service-only mode checks compiled service declarations and boot without optional integration
packages. Consumer fixtures are separate from the pinned official recipe starters.

All five recipes used `pnpm create adonisjs@3.4.0` and official starter revision
`46d235932e3eb6472a16b740fa0b47b5f69fc6fc`. API reset and invitations use the `api` kit;
React, Vue and Edge use `inertia-react`, `inertia-vue` and `hypermedia`. Their native login check
runs before package configuration. The retained evidence records the original baseline commit,
lock digest, configured patch baseline, route inventory, package versions and exact rerun command.
Recipe database engine: SQLite `3.53.4`; Core `7.6.0`. Browser recipes exercise Chromium.

- `consumer_fresh_sqlite_recipe_import_fix`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-consumer-vbMlYS/evidence.json`; Core 7.6.0, SQLite 3.53.2.
- `consumer_fresh_postgres`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-consumer-XJrFLj/evidence.json`; Core 7.6.0, PostgreSQL 16.15 (Homebrew).
- `consumer_minimum_sqlite_recipe_import_fix`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-consumer-LOZkVC/evidence.json`; Core 7.0.0, SQLite 3.53.2.
- `consumer_minimum_postgres`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-consumer-it5BcV/evidence.json`; Core 7.0.0, PostgreSQL 16.15 (Homebrew).
- `consumer_service-only_sqlite_recipe_import_fix`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-consumer-pZEPEe/evidence.json`; Isolated compiled service startup passed; optional integrations absent.
- `consumer_service-only_postgres`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-consumer-VFmmvb/evidence.json`; Isolated compiled service startup passed; optional integrations absent.
- `recipe_api-password-reset`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-KHKPbs/evidence.json`; baseline `e0ccfa1f40f55edee74aba931640644a1c6715d2`, configured `99f5d749733ccef10e563eee5987ca9b93509def`; Tests 1 passed (1); Tests 1 passed (1).
- `recipe_invitations-existing-app`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-MmApqI/evidence.json`; baseline `71e6a3e754b6ced1e8f9483b5cdf16259c4cc270`, configured `4cde48b7b282bf94f94f49feac762e7dba93eca7`; Tests 1 passed (1); Tests 1 passed (1).
- `recipe_inertia-react-password-reset`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-0fIPsv/evidence.json`; baseline `65647d4c5c364f8a3c7d946ff19cb4651976f3d8`, configured `a7d12741311c27e590b0cad87efebb195ecacc0f`; Tests 1 passed (1); Tests 1 passed (1).
- `recipe_inertia-vue-password-reset`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-zI0W9e/evidence.json`; baseline `6adcef04f16f619ab5cc54fef4ddda663880b14c`, configured `2c404edb0a05a85e219effa774de413409d0aa7c`; Tests 1 passed (1); Tests 1 passed (1).
- `recipe_hypermedia-password-reset`: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-wrk9pZ/evidence.json`; baseline `ebbec8da18986beece8c48caff25dcec3c4f05d4`, configured `b09fe6f4b8351fad26bcd395f7eda323d72d4d52`; Tests 1 passed (1); Tests 4 passed (4).

The API and invitation recipes capture links locally and make HTTP assertions; they do not prove
recipient delivery or a browser journey. The browser recipes add actual password-reset, validation,
replay, expiry and prior-session checks, including Edge without JavaScript. They do not establish
PostgreSQL recipe behavior, viewport coverage, keyboard accessibility or production mail delivery.
Earlier recipe mutation checks and accepted client-types/monorepo assessments remain dated evidence
in their recipe and example records; these runs do not replace or broaden those claims.

#### Reference examples using the same vendor archive

The archive above was copied unchanged to each example's `vendor/adonisjs-account-kit.tgz`.
Each app ran `pnpm install`, `pnpm exec node ace generate:key`, `pnpm exec node ace codegen`,
and `pnpm exec node ace migration:run --force`, followed by its own `pnpm lint`,
`pnpm typecheck`, `pnpm build` and `pnpm test`. The local `.env` files came from the app's
template with isolated loopback ports, memory limiter storage and generated keys. They are ignored.
Install-time lockfile changes needed for the vendor candidate were local validation state and were
restored before committing; generated schemas/indexes, databases, browser output and vendor archives
are not part of this change. The JSON records also verify each vendor copy's digest after its step.

| Example | Core / Assembler / Session | SQLite driver / TypeScript | Other integration         |
| ------- | -------------------------- | -------------------------- | ------------------------- |
| API     | 7.6.0 / 8.6.0 / 8.3.0      | 12.11.1 / 6.0.3            | Tuyau 1.2.3               |
| React   | 7.6.0 / 8.6.0 / 8.3.0      | 13.0.3 / 6.0.3             | React 19.3.1, Tuyau 1.2.3 |
| Vue     | 7.6.0 / 8.6.0 / 8.3.0      | 13.0.3 / 6.0.3             | Vue 3.5.44, Tuyau 1.2.3   |
| Edge    | 7.5.2 / 8.5.2 / 8.1.0      | 13.0.3 / 6.0.3             | Edge-rendered forms       |

All four use Lucid `22.4.2`, Auth `10.1.0`, Limiter `3.0.1`, Shield `9.0.0` and package `0.2.0`.
API SQLite is `3.53.2`; the three rendered apps use SQLite `3.53.4`.

| Output record                             | Source | Outcome                                            | Archive SHA-256, unchanged                                         |
| ----------------------------------------- | ------ | -------------------------------------------------- | ------------------------------------------------------------------ |
| `example_api_install`                     | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_api_generate-key`                | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_api_codegen`                     | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_api_migrate`                     | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_api_lint_recipe_import_fix`      | B      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_api_typecheck_recipe_import_fix` | B      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_api_build_recipe_import_fix`     | B      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_api_test_recipe_import_fix`      | B      | 51 passed, 19 strategy-specific skips; 19s; exit 0 | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-react_install`           | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-react_generate-key`      | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-react_codegen`           | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-react_migrate`           | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-react_lint`              | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-react_typecheck`         | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-react_build`             | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-react_test`              | A      | 33 passed; 14s; exit 0                             | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-vue_install`             | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-vue_generate-key`        | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-vue_codegen`             | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-vue_migrate`             | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-vue_lint`                | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-vue_typecheck`           | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-vue_build`               | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_inertia-vue_test`                | A      | 35 passed; 14s; exit 0                             | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_install`              | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_generate-key`         | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_codegen`              | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_migrate`              | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_lint`                 | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_typecheck`            | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_build`                | A      | Passed; exit 0                                     | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_test`                 | A      | 13 passed; 15s; exit 0                             | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |

The API reference result selects its bearer-token strategy. Session-specific tests are skipped there
and are exercised separately by the fresh consumer's session suite on both databases. A local
receiver and durable outbox restart regression are exercised by the consumer suites; no claim of
exactly-once delivery or a real external provider is made.

#### Upgrade impact and final handoff

The actual published `0.1.1` archive has SHA-256
`38fd950b08990a95b780d3077ad65f3a98bb898cb858b7b2f9eaabaae236a3d2`.
Its 313 `package/build/` files are byte-identical to this candidate, including 14 `.stub` files
(two configuration templates and twelve migration templates). Source comparison against the
`0.1.1` tag also found no changes in runtime, adapters, commands, providers, services, HTTP,
testing, configuration or migration stubs. This documentation/adoption alpha introduces no new
generated package configuration or database migration. Existing app-owned mappings and policies
remain authoritative; see the [release gate](release-gate.md#upgrade-and-rollback).

The archive still has SHA-256 `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` after all required runs.
The first final-documentation check (`docs_checks_final_record`) found one incorrect heading anchor
(12 passed, 1 failed). Correcting the anchor produced the results below at B with the pending
documentation edits; all archive digests remained unchanged. No tests were removed.

| Output record              | Outcome                                   | Archive SHA-256, unchanged                                         |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `docs_checks_final_anchor` | 13 passed; 290ms; exit 0                  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `format_final_anchor`      | Scoped Prettier check passed; exit 0      | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `docs_build_final_anchor`  | Documentation build passed; 4.40s; exit 0 | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |

Scoped formatting covers the four #642-owned files. The historical verification sections are
byte-for-byte unchanged. Publication and the post-publication advertised install smoke remain
separate owner actions.

#### Integrated review corrections — 23 October 2026

The later integration at `fbb04b0acd4fcbae6ec6815c79ece89d061a399a` includes the corrected
evidence wording (#632), invitation copy map (#636), React native-form validation-secret
protection (#633), Vue consumed-proof session checks (#634), and Edge active-session and exact
replacement-proof assertions (#635). These changes affect documentation, transplant patches and
acceptance specs. The package runtime inputs, version and templates still have no diff from
archive source A, so the candidate was not repacked.

The following reruns use the same immutable archive and Node 24.21.0/pnpm 11.23.0. Each output
record retains the exact command and digest before and after execution; the Edge example records
also verify the unchanged vendor-copy digest.

| Output record                                            | Test-source revision                       | Outcome | Archive SHA-256, unchanged                                         |
| -------------------------------------------------------- | ------------------------------------------ | ------- | ------------------------------------------------------------------ |
| `lint_review_corrections`                                | `fbb04b0acd4fcbae6ec6815c79ece89d061a399a` | Exit 0  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `typecheck_review_corrections`                           | `fbb04b0acd4fcbae6ec6815c79ece89d061a399a` | Exit 0  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_lint_review_corrections`             | `fbb04b0acd4fcbae6ec6815c79ece89d061a399a` | Exit 0  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_typecheck_review_corrections`        | `fbb04b0acd4fcbae6ec6815c79ece89d061a399a` | Exit 0  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_build_review_corrections`            | `fbb04b0acd4fcbae6ec6815c79ece89d061a399a` | Exit 0  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `example_hypermedia_test_review_corrections`             | `fbb04b0acd4fcbae6ec6815c79ece89d061a399a` | Exit 0  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_inertia-react-password-reset_review_corrections` | `b976d33c3428989b648b006de1f4e756bf9a79ca` | Exit 0  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_inertia-vue-password-reset_review_corrections`   | `633517159529d3009402ab3f8a8ad372f559a631` | Exit 0  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_hypermedia-password-reset_review_corrections`    | `fbb04b0acd4fcbae6ec6815c79ece89d061a399a` | Exit 0  | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |

The Edge reference suite passed 13/13; its lint, typecheck and build also passed. Fresh React and
Vue recipes each passed 1/1 and Edge passed 4/4, with native-login baselines and application
builds. Each recipe command above was repeated with its same `--candidate-tarball` and
`--candidate-revision` arguments; the newer records supersede the earlier recipe assertions.
Their retained evidence files are:

- React: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-lsPnJc/evidence.json`.
- Vue: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-Rwd86e/evidence.json`.
- Edge: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-selext/evidence.json`.

The native starter baselines, configured checkpoints and lockfile digests are in those P6
records. Creator 3.4.0, official starter revision
`46d235932e3eb6472a16b740fa0b47b5f69fc6fc`, Core 7.6.0 and recipe SQLite 3.53.4 remain
unchanged. The original package checks, six compatibility consumers, API/invitation recipes,
example installation steps and unchanged React/Vue application suites remain valid dated
evidence; they were not all repeated for these documentation and acceptance-spec corrections.
The new Edge run replaces its previous reference-suite evidence. Child recipe records retain
their mandatory mutation failures and restoration results. Local callback capture and Chromium
remain the browser-test limits; no recipient delivery, PostgreSQL browser coverage or new manual
inspection is claimed.

Delivery review remains separate from these automated results. On 23 October 2026 the owner
accepted the reviews performed after the existing PRs opened and approved adding the install-link
corrections in `docs/identity-creation.md` and `docs/setup.md` to #628's scope. This resolves both
programme conditions without changing the historical review sequence. The integrated #628
correction also clarifies the dated smoke record's limits and where to return from the root
installation instructions before running migrations. No package runtime or archive input changed.
No merge, package publication or release has occurred; all PRs remain open and unmerged.

#### Recipe corrections rerun — 23 October 2026

Review of the open PRs corrected five recipes after the records above. The API, React, Vue and
Edge patches now trim and lowercase the pinned starters' shared email rule; before that, a
mixed-case signup could not sign in through the patched login or receive a reset link. The Vue
patch also signs native signups in through Account Kit, so a new session carries its credential
revision. The invitation policy now permits only the `member` role. Each recipe spec gained an
assertion for its correction. The corrections and their mutation checks are recorded on #649,
#653, #655, #656 and #657.

The archive inputs have no diff from source A: package sources, templates, `package.json`,
`CHANGELOG.md`, `README-AGENTS.md`, `SECURITY.md` and the lockfile are unchanged. The candidate was
not repacked. All five recipes ran at test-source revision
`db8fcd91669b1a5bd29e13dedf3d10b7cac46bf9`, a clean checkout, with the same
`--candidate-tarball` and `--candidate-revision` arguments as above. Node 24.21.0, pnpm 11.23.0,
creator 3.4.0, official starter revision `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`, Core 7.6.0
and recipe SQLite 3.53.4 are unchanged.

| Output record                                     | Native login | Recipe acceptance | Archive SHA-256 before and after, unchanged                        |
| ------------------------------------------------- | ------------ | ----------------- | ------------------------------------------------------------------ |
| `recipe_api-password-reset_corrections`           | 1/1          | 2/2; exit 0       | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_invitations-existing-app_corrections`     | 1/1          | 1/1; exit 0       | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_inertia-react-password-reset_corrections` | 1/1          | 1/1; exit 0       | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_inertia-vue-password-reset_corrections`   | 1/1          | 2/2; exit 0       | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |
| `recipe_hypermedia-password-reset_corrections`    | 1/1          | 4/4; exit 0       | `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693` |

Retained evidence, with each configured patch checkpoint:

- API reset: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-Uix19V/evidence.json`; configured `0f89364c72e535e3a8f234371a3886a885368e37`.
- Invitations: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-LKGEPV/evidence.json`; configured `7ac1f4198eb9c9fbbf90e83058c0a39651813cc4`.
- React: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-U3qYkK/evidence.json`; configured `794185ddd02b9803ac8077927a93bbc39798ced7`.
- Vue: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-yeoqUI/evidence.json`; configured `3795cac8830657aef35cc8ea75ef128e0748fb6d`.
- Edge: `/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-fS7BGP/evidence.json`; configured `5a0a0540b6c4c6eac7caefd162f0a352b7903fac`.

These records supersede the earlier recipe records above for the five recipes. The package
checks, compatibility consumers and reference-example suites remain dated evidence and were not
repeated; the corrections change only recipe documentation, patches and acceptance specs. The
browser-test limits above still apply.

### Historical pre-inspection summary

The following summary is retained from earlier verification and is not the account-inspection
candidate result. See [Account access inspection](#account-access-inspection) for its dated evidence.

The local package gate on Node 24.21.0 and pnpm 11.23.0 passes lint, typechecking, build, 221
SQLite tests, 221 PostgreSQL 16.15 tests and four built-export tests. Coverage includes real Lucid
model hooks, central locking, transaction cleanup, bounded pagination, limiter privacy, credential
effects and pruning. Installed-consumer outcomes are recorded separately for the exact archive;
package test totals alone do not establish distribution compatibility.

The review fixes add regression coverage for early consumer-mode rejection, standalone dotenv
ignore rules, bounded cursor decoding, expiry-filtered indexed pagination, and normalized setter
values that survive commit. The copied environment template boots with its SQLite default after
an application key is supplied. The API fixture adds three authentication tests to its two existing
HTTP workflows: normalized known/unknown login limits, the client budget across rotating identities,
and the shared 128-character password boundary. Login keeps legacy passwords usable without an
input length cap. The independent review found no remaining correctness or security findings in
this tactical change.

### Reproducible checks

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm quick:test
pnpm test:built-exports
pnpm test:pg-service
pnpm test:pg
pnpm test:adapter
pnpm test:consumer -- --database=sqlite
pnpm test:consumer -- --database=postgres
pnpm test:consumer -- --mode=minimum --compatibility=minimum --database=sqlite
pnpm test:consumer -- --mode=minimum --compatibility=minimum --database=postgres
pnpm test:consumer -- --mode=service-only --database=sqlite
pnpm test:consumer -- --mode=service-only --database=postgres
```

The service-only mode installs the packed candidate in a separate minimal application, builds
with full declaration checking, and boots the compiled account service with the selected
database. It verifies that authentication, session, shield, Tuyau, mail, and Ally integrations
are absent. Core and its transitive validation dependencies remain installed as required by
AdonisJS.

For authentication integration, the fresh API consumer runs both the default
`access_tokens` route group and the `session` route group using a server-side session store.
The session fixture exercises CSRF bootstrap, fixation protection, protected access, revision
revocation, and logout. Run the service-only mode separately
for both databases to check that optional Auth and Session imports do not enter the generic
service declarations.

The fresh API consumer also removes the fixture's admission provider, command loader and
`config/admission.ts`, runs `account-kit:admission:install` with the run's `--users-table` and
`--user-id-type`, and checks that exactly one provider and one loader are registered. Its suites
include `examples/api/tests/functional/admission.spec.ts` for both strategies, then run that spec again with
`ACCOUNT_KIT_ADMISSION_DOMAINS=example.test` for the domain case. The service-only consumer does
not install admission.

#### Account access inspection

Recorded 21 October 2026 for #600 and #607–#611. The integration candidate at
`b9816045a5c46d77681ac13ac37942b47e379b43` contains the four prerequisite changes below,
based on `main` at `628361e42756101585fa9ef69769b489a27aabd1`.

| Issue | Pull request                                                           | Source commit                              |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------ |
| #607  | [#612](https://github.com/Kevinjohn/oss-adonisjs-account-kit/pull/612) | `d00b91b11648361d8ce22caeb24c5fb0d6715bda` |
| #608  | [#613](https://github.com/Kevinjohn/oss-adonisjs-account-kit/pull/613) | `23f1d64b415ecefa41e3bda13305bbecd4582b90` |
| #609  | [#614](https://github.com/Kevinjohn/oss-adonisjs-account-kit/pull/614) | `c695d295713df7d57093a515d89a25584f11be5c` |
| #610  | [#615](https://github.com/Kevinjohn/oss-adonisjs-account-kit/pull/615) | `855136a5c72ab17a99dde13a604ebfff27a165ec` |

These PRs remain open and unmerged for the requested delivery. This records candidate integration
evidence, not verification of a merged `main`. After approved merges, rerun the final gate from
`main` and record its resulting SHA. Merge order: #612, #613, then #614 and #615 independently,
then the delivery PR for #611. There is no version bump, no publication.

The common gate ran as one fail-fast script with Node 24.21.0 pinned for all child commands,
pnpm 11.23.0 and PostgreSQL 16.15. Every command below exited 0.

| Command                      | Result                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm lint`                  | Passed                                                                                |
| `pnpm typecheck`             | Passed                                                                                |
| `pnpm build`                 | Passed                                                                                |
| `pnpm quick:test`            | 1,081 passed; two PostgreSQL-only skips                                               |
| `pnpm test:built-exports`    | Two passed, including inspection denial and error-class identity across built exports |
| `pnpm test:pg-service`       | 61 passed                                                                             |
| `DB_PORT=55432 pnpm test:pg` | 1,080 passed; three SQLite-only skips                                                 |
| `pnpm docs:build`            | Passed                                                                                |

Each prerequisite PR also records its own full gate and focused checks. #608 passes the
documentation-link checks; #610's two focused concurrency tests pass on both databases.
#609 covers the SQLite cleanup fault as well as a PostgreSQL deferred-constraint COMMIT rejection.
The initial gate did not run MySQL. A follow-up on source-equivalent head
`345c5f76daec3da76c390fc32350709a1a8c2c33` ran `DB_PORT=33307 pnpm test:mysql`
on native MySQL 8.4.13: 1,077 passed and five dialect-specific tests skipped. The disposable
server used UTC and was stopped afterward. MySQL remains experimental because it is not in
the per-change CI matrix.

Installed consumers both compiled with `skipLibCheck: false` and booted the service. They verify
the public inspection types and method, the denial export, and `InvalidInputError` before a
transaction can reach the intentionally absent account schema. Auth, Session, Shield, Tuyau,
Mail and Ally packages are absent in both installations. SQLite reports 3.53.2.

The consumer sequence passed in one script, with PostgreSQL stopped through an exit trap:

```sh
pnpm test:consumer -- --mode=service-only --database=sqlite
DB_PORT=55436 pnpm pg:start
createdb -h 127.0.0.1 -p 55436 -U account_kit account_kit_consumer
DB_PORT=55436 pnpm test:consumer -- --mode=service-only --database=postgres
DB_PORT=55436 pnpm pg:stop
```

Both runs packed `adonisjs-account-kit-0.0.0.tgz` from candidate
`b9816045a5c46d77681ac13ac37942b47e379b43`. Their evidence files report successful installation,
compilation and startup; the archive bytes were independently checked against each recorded digest.

| Consumer   | Candidate SHA-256                                                  |
| ---------- | ------------------------------------------------------------------ |
| SQLite     | `b7cb3b7ddd1b645c0ea35f04b315d0635ad4b868be47fe6771639b0ca06c299b` |
| PostgreSQL | `b7cb3b7ddd1b645c0ea35f04b315d0635ad4b868be47fe6771639b0ca06c299b` |

The prerequisite PR descriptions record these mutation results. Every mutation was restored;
each failure was checked against its named test rather than an empty test run or loading failure.

| Mutation                                          | Evidence                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Denial status 403 → 404                           | The dedicated denial-identity unit test and error-reference catalog test fail                                                             |
| Accept empty-string user IDs                      | The user-ID domain test fails                                                                                                             |
| Remove adapter/witness ID comparison              | Test 13, different-account substitution, fails                                                                                            |
| Replace strict boolean validation with `!allowed` | Test 9 fails, including an isolated numeric `1` case                                                                                      |
| Allow an undefined persisted revision             | The undefined-column revision unit test fails                                                                                             |
| Remove dependency-denial wrapping                 | Test 10, operational dependency failures with their causes, fails                                                                         |
| Read input ID again after awaiting                | Test 19, copied input getters, fails                                                                                                      |
| Require authentication before input validation    | Test 17, invalid input with disabled authentication, fails                                                                                |
| Remove adapter-ID validation                      | Test 14, malformed adapter ID, fails                                                                                                      |
| Hard-code the users table                         | Test 20, custom members table, fails                                                                                                      |
| Advance credentials during inspection             | All four INS-06 read-only snapshot tests fail                                                                                             |
| Touch the limiter during inspection               | Typecheck passes; all four INS-06 tests fail with `limiter touched`                                                                       |
| Remove witness `.forUpdate()`                     | PostgreSQL's reader-lock probe test fails because `55P03` is absent; both SQLite tests still pass under its transaction-start writer lock |

The changelog includes `AccountAccessDeniedError` and
`authentication.inspectAccountAccess`. These archives are consumable candidate artifacts; no
package version was changed and nothing was published to the package registry.

##### Review corrections and MySQL follow-up: 21 October 2026

The revised source candidate `5b8bceb80408849e9561d06cc8b8e7fbef72024a` supersedes the
initial candidate above. The responsibility split was committed separately and passed the full
required package gate at `9ae5b9b2fcd7f2b5a0e58b33b343f697727b99b3` before subsequent changes.
Projection and configuration guards now have focused modules, with original exports preserved;
core inspection, schema compatibility and effects/failure suites have separate files. No inspection
behavior or test assertions were removed. The subsequent independent assembled review closed all
reported findings, including error/retry guidance, historical evidence labels, API comments,
changelog adjacency and concurrency evidence.

The final candidate passed the following checks with Node 24.21.0 and pnpm 11.23.0:

| Check                                       | Result                                                         |
| ------------------------------------------- | -------------------------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Passed                                                         |
| `pnpm quick:test`                           | 1,081 passed; two skipped                                      |
| `pnpm test:built-exports`                   | Two passed                                                     |
| `pnpm test:pg-service`                      | 61 passed                                                      |
| `DB_PORT=55438 pnpm test:pg`                | 1,080 passed; three skipped; PostgreSQL 16.15                  |
| `DB_PORT=33307 pnpm test:mysql`             | 1,077 passed; five skipped; native MySQL 8.4.13                |
| `pnpm docs:build`                           | Passed                                                         |
| Service-only installed consumer, SQLite     | Install, full declaration checking and compiled startup passed |
| Service-only installed consumer, PostgreSQL | Install, full declaration checking and compiled startup passed |

Both concurrency scenarios also passed as focused tests on SQLite, PostgreSQL and MySQL.
For both row-lock engines they observe the actual waiting and blocking connections in both lock
orders, rather than counting unrelated cluster locks or merely checking an unsettled promise.
The native NOWAIT/update probes and before/after snapshot assertions remain in place.
Removing the witness row lock made the MySQL lock-ownership assertion fail as expected;
injecting an early inspection failure surfaced its original error in 0.98 seconds rather than
hanging on a callback barrier. Both probes restored the original source afterward.

Both fresh installed consumers used this source candidate, required `skipLibCheck: false`,
and verified that optional backend authentication integrations were absent. The actual archive
bytes were independently checked against the recorded SHA-256 values:

| Consumer   | Candidate archive SHA-256                                          |
| ---------- | ------------------------------------------------------------------ |
| SQLite     | `01ee8259fefe17391763f72251523f0955ae7df2f872a31a4890068f877f91ab` |
| PostgreSQL | `01ee8259fefe17391763f72251523f0955ae7df2f872a31a4890068f877f91ab` |

MySQL was tested with UTC database connections while the test process used `America/New_York`.
Its experimental status is unchanged: it is still outside the per-change CI matrix. Disposable
MySQL and PostgreSQL servers were stopped after their checks. These are pre-merge candidate
results; the merged-main gate remains a delivery step after approved merges. The follow-up
verification-record commit changes documentation only.

#### Vocabulary alignment: 15 October 2026

The vocabulary implementation and review fixes at `f526a5e4e94ff730a8f63873a23b54619820e288`
pass on Node 24.21.0 and pnpm 11.23.0: lint, typecheck, build, 221 SQLite tests, 221 PostgreSQL
16.15 tests and four built-export tests. Lint, typecheck, build and SQLite tests emit no warnings.
The 61 PostgreSQL service checks retain their passing evidence because their implementation and
harness are unchanged. The final source tree also passes the repository formatter.

Fresh and historical-upgrade packed API consumers pass on SQLite and PostgreSQL, including
configuration, migrations, application lint/format/typecheck and all five HTTP tests per consumer.
The upgrade scenario also runs its dedicated baseline and candidate assertions. Both database
runs installed the same candidate archive, SHA-256
`3a78a1823ddb3ea950ca0a1e880f522555da2fe5d0c2b0b4a72381836c7260f2`.
The historical stage-3 baseline archive was verified against SHA-256
`a98d746e90bef50bb71ba6d5bd4b0b138a302314bc2eeedcf998232b725606df`.
The PostgreSQL test server was stopped after validation. Later documentation-only changes do not
change the verified implementation; these archives are local test evidence, not published packages.

The upgrade fixture leaves a reset token outstanding before migration, then compares its ID,
user, email, hash, expiry and creation timestamp after the table rename. It inspects and redeems
the same proof, rejects replay, verifies the changed password and retains the user/role/migration
checks. The raw proof travels only through a mode-0600 temporary file, removed before redemption
assertions. A mutation that deleted token rows during migration failed at the expected missing-row
assertion; the harness was restored byte-for-byte before PostgreSQL verification.

The packaging regression first reproduced private-document inclusion, then passed with explicit
archive exclusions. Inspection of the actual candidate archive confirmed that private planning
and review files are absent while public documentation and examples remain. The minimum-version
SQLite consumer passes and its captured output reports `passwordReset` and `emailVerification`
in the public-operation marker, with corresponding current stage labels.

The numeric-seconds expiry helper and real encrypted email-verification proof regressions retain
their earlier mutation evidence: each failed without numeric handling and passed after restoration.
The verification proof remains valid after 59 minutes and expires by 61 minutes for a 3600-second
setting. All three requested review fixes are addressed; no required findings remain. No package
publication or hosted workflow execution was performed.

#### Local PostgreSQL package tests

Use Node 24 (`nvm use`) and installed PostgreSQL 16 binaries. On macOS, install them with
`brew install postgresql@16`; the wrapper also supports a PostgreSQL 16 `pg_ctl` on PATH with
its companion utilities in the same directory. It does not install software or use Homebrew
services. Run `pnpm test:pg-service` for the isolated lifecycle regression checks.

`pnpm test:pg` starts the checkout's disposable server, runs the package suite and stops the
server on success, failure or interruption. Selectors are forwarded:
`pnpm test:pg --files=db.spec.ts`. A cluster explicitly started with `pnpm pg:start` is preserved;
managed tests refuse it until `pnpm pg:stop`.

| Setting  | Managed value              |
| -------- | -------------------------- |
| Host     | `127.0.0.1`                |
| Port     | `DB_PORT`, default `55432` |
| User     | `account_kit`              |
| Password | empty                      |
| Database | `account_kit_test`         |

Only `DB_PORT` configures the managed wrapper. It uses trust authentication, UTF-8, C locale,
loopback TCP without Unix sockets, and `fsync=off`. Data at `tmp/pg16` persists for reuse and is
disposable; logs are at `tmp/pg16.log`. Never store application or consumer data there.
Mutating commands hold a nonblocking checkout lock at `tmp/pg16.lock` throughout tests and cleanup.
Another checkout's cluster or an unrelated listener is never adopted.
Ownership checks verify the executable, complete managed command and physical process directory.
Process directory inspection uses macOS's built-in `/usr/sbin/lsof` or Linux `/proc`; Linux
also resolves the physical executable through `/proc`. Unavailable or ambiguous inspection
fails closed rather than stopping the process. Other platforms are rejected before startup.

For repeated runs, when other connection variables are unset or have their defaults:

```sh
pnpm pg:start
DB_CLIENT=pg pnpm quick:test
pnpm pg:stop

DB_PORT=55433 pnpm pg:start
DB_PORT=55433 DB_CLIENT=pg pnpm quick:test
DB_PORT=55433 pnpm pg:stop
```

For a shell with connection overrides, use the full fixed connection values when testing an
explicitly started cluster:

```sh
DB_CLIENT=pg DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=account_kit DB_PASSWORD= DB_DATABASE=account_kit_test pnpm quick:test --files=db.spec.ts
```

`bash bin/pg.sh status` reports the owned cluster's state (exit 0 running, 3 stopped). Readiness
at the selected port is diagnostic only. `bash bin/pg.sh reset` stops and deletes only the owned
disposable data, initializes it again and leaves a fresh server running; use `pnpm pg:stop`
afterward. Wrong-version or incomplete data requires this explicit reset.

After SIGKILL or power loss, a `postmaster.pid` left by a dead server is treated as stopped and
replaced on the next start. A stale lock is intentionally retained. Inspect `tmp/pg16.lock/owner`
and check that PID with `ps` and `kill -0`. Only after establishing that its owner no longer exists,
remove the owner file and empty lock directory, then run `pnpm pg:stop`. A missing owner file or
an uninspectable/live PID requires inspecting running script processes before removal. Never use
recursive deletion to bypass a busy command; ordinary reset does not reclaim a stale lock.

For an externally managed PostgreSQL 16 server, set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`
and `DB_DATABASE`, then run `DB_CLIENT=pg pnpm quick:test` (or `pnpm test` for lint and coverage).
The wrapper always targets its owned cluster. Packed-consumer checks provision separate databases;
these package checks do not satisfy their distinct validation gate.

#### MySQL package tests

`pnpm test:mysql` runs the package suite against an external MySQL 8.4 server, with the Node
process in a non-UTC time zone (`America/New_York`) so a missed UTC conversion fails. Set
`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_DATABASE`; the defaults are
`127.0.0.1:33306`, `root`, no password and `account_kit_test`. The harness sets the session time
zone to UTC on every connection. A throwaway Homebrew server:

```sh
brew install mysql@8.4
"$(brew --prefix mysql@8.4)/bin/mysqld" --initialize-insecure --datadir=/tmp/ak-mysql
"$(brew --prefix mysql@8.4)/bin/mysqld" --datadir=/tmp/ak-mysql --port=33306 \
  --socket=/tmp/ak-mysql.sock --mysqlx=OFF &
"$(brew --prefix mysql@8.4)/bin/mysql" -uroot -h127.0.0.1 -P33306 -e 'create database account_kit_test'
pnpm test:mysql
```

The concurrency tests identify the actual waiting and blocking connections using
`performance_schema.data_lock_waits`, `performance_schema.data_locks` and
`performance_schema.threads`. The test account needs SELECT access to these diagnostic tables;
the default disposable root account has it. These permissions are test-only; application
inspection does not query Performance Schema.

The packed-consumer checks stay on SQLite and PostgreSQL; the MySQL evidence is this suite.

#### Local service verification: 15 October 2026

These results were produced from uncommitted service/tooling changes on branch
`local-postgresql-tests`, based on `9776e938bbcb7c4c196b8bcbe0e2639e1dc7e206`. They are not
results for the clean base alone. The environment was macOS Bash 3.2, Node 24.21.0, pnpm 11.23.0
and PostgreSQL 16.15 (Homebrew), using the default managed port 55432.

The integrated commands passed: `bash -n bin/pg.sh`, the scoped Prettier check, `pnpm lint`,
`pnpm typecheck`, `pnpm build`, `DB_CLIENT=better-sqlite3 pnpm quick:test` (205 tests),
`pnpm test:pg-service` (60 tests), `pnpm test:pg` (205 tests) and
`DB_CLIENT=better-sqlite3 pnpm test:built-exports` (four tests).

Real-service checks also passed for repeated start/stop, preserving a standalone cluster,
refusing a different port without changing its server, reset with database creation, invocation
from `tests/`, hostile PG*/DB\_* settings, a live non-PostgreSQL listener, missing binaries and
wrong-version reset recovery. A temporary failing Japa test produced exit 1 with 205 passing
tests and one deliberate failure; cleanup still completed. Selector forwarding selected only
`db.spec.ts`. A directly spawned wrapper interrupted with SIGINT exited 130, terminated the
runner's process group, stopped its server and removed its lock. Temporary tests and markers
were removed. Managed runs ended with status 3, no owned server and no lock. The regression
harness additionally covered TERM, repeated signals during cleanup, overlapping commands,
shutdown failures, stale locks and foreign process/path identities, including a directory name
that would otherwise make flattened process arguments ambiguous. A TERM-resistant descendant
exercised forced termination. The corrected service and real acceptance checks were rerun after
ownership hardening. `DB_PORT=055432` started and reused the real server on decimal port 55432;
both its PID file and SQL `show port` confirmed that value, followed by successful cleanup.
Linux executable/directory inspection and early unsupported-platform refusal have deterministic
fake-inspection regression coverage; real PostgreSQL service verification was on macOS only.

The package allowlist is unchanged and excludes the root service script, regression harness
and managed data/logs. The consumer matrix and hosted CI were not rerun for this tooling change;
their earlier evidence remains separate.

#### Packed-consumer checks

The consumer harness writes an `evidence.json` record with the candidate revision, archive digest,
concrete dependency/database versions and each command outcome. A packed installation must
resolve its actual archive, with no repository-source link. The final candidate record accompanies
the pull request; historical development archives do not count as evidence for it.

The latest-compatible API fixture exercises fresh applications on both databases,
including all HTTP flows, required profile data, string/UUID IDs and a custom table, confirmations,
non-disclosing password reset responses, permission failures, scanner-safe inspection, token revocation,
and retryable outbox delivery. The exact-floor consumer independently typechecks the public
package API and exercises rollback, deferred commit failure, post-commit failure and concurrent
acceptance on both databases. See [compatibility](../compatibility.md) for the distinct dependency sets.

The exact-floor consumer also loads every public entry point and boots Ace with the package
command collections registered to run `migration:run --force`, the same path a consumer's
`node ace` takes. On 22 October 2026 the SQLite floor run passed with Core 7.0.0, assembler
8.0.0, Lucid 22.4.2, limiter 3.0.0 and Luxon 3.0.0 after `configProvider` moved to the root
`@adonisjs/core` import. Restoring the `@adonisjs/core/config` import in the installed archive made
both the entry-point and Ace steps fail with the consumer's original `SyntaxError`; the subpath
exports `configProvider` only from Core 7.5.1. The repository lint rule rejects that import.

For a prebuilt immutable candidate, supply `--candidate-tarball=PATH --candidate-revision=REV`.
Schema variants use `--mode=fresh --user-id-type=string` (or `uuid`) with
`--users-table=account_users`. The harness records a representative contention measurement; this
is a smoke check for blocking and duplicate acceptance, not a throughput benchmark.

#### Credential and invitation failure coverage

The links below identify the current regression evidence for failures before commit, callback
failures after commit, and API outbox interruption. A callback failure after commit means the
change is durable even when the caller receives the documented follow-up error. The original API
outbox retry test covers a callback failure and retry in the same process; the new process-restart
test separately verifies persisted pending-row recovery. Each process has its own in-memory
receiver, so restart recovery does not establish exactly-once delivery.

| Flow                         | Failure before commit                                                                                                                                                                                                                                                                                                | Callback failure after commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Dispatcher interruption and restart                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password reset               | [`password_reset_request.spec.ts`](../../tests/password_reset_request.spec.ts): `issuance hook sees the locked current user and rolls back a rejected replacement`; [`password_reset_redeem.spec.ts`](../../tests/password_reset_redeem.spec.ts): `adapter failure rolls back token consumption and password change` | [`password_reset_request.spec.ts`](../../tests/password_reset_request.spec.ts): `URL callback failure is a delivery error after commit`; [`password_reset_redeem.spec.ts`](../../tests/password_reset_redeem.spec.ts): `post-commit failure preserves the changed password and reports its cause`; API diagnostics and pending outbox row: [`account_password_reset.spec.ts`](../../examples/api/tests/functional/account_password_reset.spec.ts), `password reset over HTTP hides unknown accounts, consumes tokens once, and retries the outbox` | Not applicable to the package reset callbacks. Credential-notice dispatcher coverage is in the API outbox row.                                                                                                                                                                                                                                                                                                                                             |
| Password change              | PostgreSQL only: [`transaction_postgres.spec.ts`](../../tests/transaction_postgres.spec.ts): `a PostgreSQL commit failure rejects password change and suppresses its post-commit callback`                                                                                                                           | [`credentials_password_change.spec.ts`](../../tests/credentials_password_change.spec.ts): `postcommit callback failure preserves the password change and invalidation`; API diagnostics: [`account_password_change.spec.ts`](../../examples/api/tests/functional/account_password_change.spec.ts), `password change over HTTP requires proof, revokes other tokens, and reports follow-up failures`                                                                                                                                                | Not applicable to the package password-change callbacks. Credential-notice dispatcher coverage is in the API outbox row.                                                                                                                                                                                                                                                                                                                                   |
| Invitation                   | [`invitations_acceptance.spec.ts`](../../tests/invitations_acceptance.spec.ts): `the generated invitation hook setup error rolls back user creation and token consumption`                                                                                                                                           | [`invitations_acceptance.spec.ts`](../../tests/invitations_acceptance.spec.ts): `emits the accepted event once after a committed cleanup fault`; API revocation diagnostics: [`account_invitations.spec.ts`](../../examples/api/tests/functional/account_invitations.spec.ts), `invitations over HTTP enforce roles, single acceptance, resend, and revocation`                                                                                                                                                                                    | Not applicable; invitations use post-commit callbacks and do not use the credential-notice dispatcher.                                                                                                                                                                                                                                                                                                                                                     |
| API credential-notice outbox | [`run.ts`](../../examples/api/compatibility/run.ts): the minimum-compatibility `rollback-verified` assertion checks the reset proof remains usable and no outbox row remains after the credential transaction hook throws. This is a consumer-script assertion, not a named Japa test.                               | [`account_password_reset.spec.ts`](../../examples/api/tests/functional/account_password_reset.spec.ts): `password reset over HTTP hides unknown accounts, consumes tokens once, and retries the outbox` checks that a failed post-commit password notice leaves the committed outbox row pending with zero dispatcher attempts.                                                                                                                                                                                                                    | [`account_password_reset.spec.ts`](../../examples/api/tests/functional/account_password_reset.spec.ts): `the credential notice outbox recovers after a worker process restarts` kills the first worker after delivery acceptance and before `sent_at`; a fresh worker retries the same `operation_id` and marks the row sent. Each process has its own in-memory receiver, so duplicate delivery is possible and exactly-once delivery is not established. |

The latest-compatible API consumer suite, using test source revision
`8e491486d47523eafbd99f3c242be35eed70fe87` and package archive revision
`402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf` (SHA-256
`fd01e7fcb561f04934c5abb58701271515e9f55afeca1a8465aa913896669227`), passed on SQLite and
PostgreSQL 16.15 (51 passed, 19 skipped on each database). The runs used Node 24.21.0 and pnpm
11.23.0. The restart case passed in 908.9 ms on SQLite and 944.51 ms on PostgreSQL.

A disposable SQLite mutation changed the pending-row query to return no rows after worker one was
interrupted. The restarted-worker assertion failed as expected (`delivered` was 0 instead of 1).
The mutation and test fixture were restored byte-for-byte; the focused test then passed 2/2 in 3 s,
with the restart case completing in 880.53 ms.

### Mutation evidence

The previous SQLite application-row locking regression reproduced a phantom UPDATE-trigger audit entry before replacement. Normalized input and missing setup-hook regressions were demonstrated before their fixes. The current expiry-refresh pruning regression preserves a row refreshed after batch selection.

Nineteen scoped mutation runs deliberately weakened changed guards for normalized email, the
actual generated acceptance hook, trusted registration, capability checks, credential-hook
exclusivity, HMAC framing, the four invitation budgets, the three atomic credential hooks,
password notices, independent post-commit effects, pruning expiry rechecks, central PostgreSQL
row locking and SQLite writer locking. Every run produced an expected regression failure. Each
source file was restored byte-for-byte before integrated verification. These runs used disposable
fixtures; they do not claim mutation coverage for unchanged historical guards.

### Delivery boundaries

No package publication, version change, release, hosted workflow execution, starter integration or owner-application integration is included. The working name and final publication version remain owner decisions. Historical checkpoints are retained in the repository's [manual record](manual-check.md); they are not current candidate evidence.

### Starter baselines

Recorded 22 October 2026 from the official [starter-kits](https://github.com/adonisjs/starter-kits/tree/46d235932e3eb6472a16b740fa0b47b5f69fc6fc) revision `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`. Each kit was scaffolded outside this repository with Node 24.21.0, pnpm 11.23.0 and `create-adonisjs` 3.4.0. The generated dependency versions below are the ranges in each generated `package.json`.

| Kit           | Scaffold command                                                                                                                        | Baseline commit                            | `pnpm-lock.yaml` SHA-256                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| API           | `pnpm create adonisjs@3.4.0 <dir> --kit=github:adonisjs/starter-kits/api#46d235932e3eb6472a16b740fa0b47b5f69fc6fc --pkg=pnpm`           | `145270d13bcc5da1022c2b02540ea7e61f34d7b7` | `8e460c40eb5f4434146cc653c565892d2581d4a29e8f1f1756a4bb500f1f3d0d` |
| Inertia React | `pnpm create adonisjs@3.4.0 <dir> --kit=github:adonisjs/starter-kits/inertia-react#46d235932e3eb6472a16b740fa0b47b5f69fc6fc --pkg=pnpm` | `14573b4b8a49fc18ad719ed97d0005ac82061447` | `cc0a3df81c5e524e662cd4d4cd4c015c8b546f9cc9fd88d95ba99489cd7ac7ee` |
| Inertia Vue   | `pnpm create adonisjs@3.4.0 <dir> --kit=github:adonisjs/starter-kits/inertia-vue#46d235932e3eb6472a16b740fa0b47b5f69fc6fc --pkg=pnpm`   | `27ccef05198e15a784d42e5c968a39c68c5f8731` | `758adec76940f6069bf43c0a7856f44f4af76ed247c4af723527a2ad187be2e4` |
| Hypermedia    | `pnpm create adonisjs@3.4.0 <dir> --kit=github:adonisjs/starter-kits/hypermedia#46d235932e3eb6472a16b740fa0b47b5f69fc6fc --pkg=pnpm`    | `4a4be43278a59ea7e9ca30362dbe14e419268a9b` | `15448961b3b6caa132cbe17fe3ec0b5c4a044694eebb4221815ddb1fbad74bea` |

The scaffolder's optional Git initialization is disabled by default. Each disposable project was initialized and committed as `starter` after scaffold preparation and before any Account Kit changes. Comparing each generated tree with its matching pinned upstream directory found them **identical except generated files**: the scaffolder removes the upstream README and `.yarnrc.yml`, renames the package, clears the sample `APP_KEY` in `.env.example`, writes `.env` with a fresh key, and creates the pnpm lockfile and SQLite database. It also formats the API kit's generated `database/schema.ts`; other application source files match byte-for-byte. The database file is ignored and is not in the baseline commit.

Each check ran before Account Kit installation or configuration. The API test used its original token-login route and protected profile route; browser tests used each starter's own login form and made both the post-login and a second direct request to its protected dashboard.

| Kit           | Check command                                    | Original login and protected route result                                                                                                                                                    |
| ------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API           | `pnpm test --files=pinned_starter_login.spec.ts` | 1/1 passed in 274 ms. Guest `GET /api/v1/account/profile` returned 401; `POST /api/v1/auth/login` returned a bearer token; the token then authorized the protected profile request with 200. |
| Inertia React | `pnpm test --files=pinned_starter_login.spec.ts` | 1/1 passed in 847 ms. Submitted the native `/login` form, then loaded `/dashboard` and made a second direct `/dashboard` request.                                                            |
| Inertia Vue   | `pnpm test --files=pinned_starter_login.spec.ts` | 1/1 passed in 970 ms. Submitted the native `/login` form, then loaded `/dashboard` and made a second direct `/dashboard` request.                                                            |
| Hypermedia    | `pnpm test --files=pinned_starter_login.spec.ts` | 1/1 passed in 408 ms. Submitted the native `/login` form, then loaded `/dashboard` and made a second direct `/dashboard` request.                                                            |

These temporary test specs exercised the native user model, login form or endpoint, and protected route with a real HTTP server. They also asserted Node 24 and prepared the disposable database. The Vue test clone temporarily registered the starter's existing `browserClient` dependency in `tests/bootstrap.ts`, which that starter did not register by default. These test and bootstrap changes were confined to disposable clones; application controllers, routes, models and other application source files were unchanged.

The browser kits use the cookie session store: `.env.example` sets `SESSION_DRIVER=cookie`, and `config/session.ts` selects `env.get('SESSION_DRIVER')`. The session recipes must switch to a server-side store. The API check uses bearer authentication; its generated session configuration has the same cookie default but is not used for the login proof.

Generated `package.json` dependency ranges:

- **API** — dependencies: `@adonisjs/auth@^10.1.0`, `@adonisjs/core@^7.5.2`, `@adonisjs/cors@^3.0.0`, `@adonisjs/lucid@^22.4.2`, `@adonisjs/session@^8.1.0`, `@adonisjs/shield@^9.0.0`, `@japa/api-client@^3.2.1`, `@tuyau/core@^1.2.2`, `@vinejs/vine@^4.4.0`, `better-sqlite3@^13.0.3`, `luxon@^3.7.2`, `reflect-metadata@^0.2.2`; devDependencies: `@adonisjs/assembler@^8.5.2`, `@adonisjs/eslint-config@^3.1.0`, `@adonisjs/prettier-config@^1.5.0`, `@adonisjs/tsconfig@^2.0.0`, `@japa/assert@^4.2.0`, `@japa/plugin-adonisjs@^5.2.0`, `@japa/runner@^5.3.0`, `@poppinss/ts-exec@^1.4.4`, `@types/luxon@^3.7.5`, `@types/node@~26.6.2`, `eslint@^10.11.0`, `hot-hook@^1.0.0`, `pino-pretty@^13.1.3`, `prettier@^3.9.9`, `typescript@~6.0.3`, `youch@^4.1.1`.
- **Inertia React** — dependencies: `@adonisjs/auth@^10.1.0`, `@adonisjs/core@^7.5.2`, `@adonisjs/cors@^3.0.0`, `@adonisjs/inertia@^5.0.1`, `@adonisjs/lucid@^22.4.2`, `@adonisjs/session@^8.1.0`, `@adonisjs/shield@^9.0.0`, `@adonisjs/static@^2.0.1`, `@adonisjs/vite@^6.0.2`, `@inertiajs/core@^3.7.1`, `@inertiajs/react@^3.7.1`, `@tuyau/core@^1.2.2`, `@vinejs/vine@^4.4.0`, `better-sqlite3@^13.0.3`, `edge.js@^6.5.1`, `lucide-react@^1.48.0`, `luxon@^3.7.2`, `react@^19.3.0`, `react-dom@^19.3.0`, `reflect-metadata@^0.2.2`, `sonner@^2.0.8`; devDependencies: `@adonisjs/assembler@^8.5.2`, `@adonisjs/eslint-config@^3.1.0`, `@adonisjs/prettier-config@^1.5.0`, `@adonisjs/tsconfig@^2.0.0`, `@japa/assert@^4.2.0`, `@japa/browser-client@^2.3.0`, `@japa/plugin-adonisjs@^5.2.0`, `@japa/runner@^5.3.0`, `@poppinss/ts-exec@^1.4.4`, `@types/luxon@^3.7.5`, `@types/node@~26.6.2`, `@types/react@^19.3.0`, `@types/react-dom@^19.3.0`, `@vitejs/plugin-react@^6.1.1`, `eslint@^10.11.0`, `eslint-plugin-react@^7.37.5`, `eslint-plugin-react-hooks@^7.1.1`, `hot-hook@^1.0.0`, `pino-pretty@^13.1.3`, `prettier@^3.9.9`, `typescript@~6.0.3`, `vite@^8.3.0`, `youch@^4.1.1`.
- **Inertia Vue** — dependencies: `@adonisjs/auth@^10.1.0`, `@adonisjs/core@^7.5.2`, `@adonisjs/cors@^3.0.0`, `@adonisjs/inertia@^5.0.1`, `@adonisjs/lucid@^22.4.2`, `@adonisjs/session@^8.1.0`, `@adonisjs/shield@^9.0.0`, `@adonisjs/static@^2.0.1`, `@adonisjs/vite@^6.0.2`, `@inertiajs/core@^3.7.1`, `@inertiajs/vue3@^3.7.1`, `@tuyau/core@^1.2.2`, `@vinejs/vine@^4.4.0`, `@vue/server-renderer@^3.5.43`, `better-sqlite3@^13.0.3`, `edge.js@^6.5.1`, `lucide-vue-next@^1.0.0`, `luxon@^3.7.2`, `reflect-metadata@^0.2.2`, `vue@^3.5.43`, `vue-sonner@^2.0.9`; devDependencies: `@adonisjs/assembler@^8.5.2`, `@adonisjs/eslint-config@^3.1.0`, `@adonisjs/prettier-config@^1.5.0`, `@adonisjs/tsconfig@^2.0.0`, `@japa/assert@^4.2.0`, `@japa/browser-client@^2.3.0`, `@japa/plugin-adonisjs@^5.2.0`, `@japa/runner@^5.3.0`, `@poppinss/ts-exec@^1.4.4`, `@types/luxon@^3.7.5`, `@types/node@~26.6.2`, `@vitejs/plugin-vue@^6.0.9`, `eslint@^10.11.0`, `eslint-plugin-vue@^10.11.1`, `hot-hook@^1.0.0`, `pino-pretty@^13.1.3`, `prettier@^3.9.9`, `typescript@~6.0.3`, `vite@^8.3.0`, `vue-tsc@^3.3.11`, `youch@^4.1.1`.
- **Hypermedia** — dependencies: `@adonisjs/auth@^10.1.0`, `@adonisjs/core@^7.5.2`, `@adonisjs/lucid@^22.4.2`, `@adonisjs/session@^8.1.0`, `@adonisjs/shield@^9.0.0`, `@adonisjs/static@^2.0.1`, `@adonisjs/vite@^6.0.2`, `@vinejs/vine@^4.4.0`, `better-sqlite3@^13.0.3`, `edge-iconify@^2.0.2`, `edge.js@^6.5.1`, `luxon@^3.7.2`, `reflect-metadata@^0.2.2`; devDependencies: `@adonisjs/assembler@^8.5.2`, `@adonisjs/eslint-config@^3.1.0`, `@adonisjs/prettier-config@^1.5.0`, `@adonisjs/tsconfig@^2.0.0`, `@iconify-json/lucide@^1.2.136`, `@japa/assert@^4.2.0`, `@japa/browser-client@^2.3.0`, `@japa/plugin-adonisjs@^5.2.0`, `@japa/runner@^5.3.0`, `@poppinss/ts-exec@^1.4.4`, `@types/alpinejs@^3.13.11`, `@types/luxon@^3.7.5`, `@types/node@~26.6.2`, `alpinejs@^3.17.4`, `eslint@^10.11.0`, `hot-hook@^1.0.0`, `pino-pretty@^13.1.3`, `prettier@^3.9.9`, `typescript@~6.0.3`, `vite@^8.3.0`, `youch@^4.1.1`.

For React, the exact D2 command downloaded the pinned tree, but its initial package install could not reach the registry from the sandbox. The generated lockfile was resolved from registry metadata and then installed successfully with `CI=true pnpm install --frozen-lockfile`; the scaffolder's prepare actions and migration were completed before committing the baseline. The resulting tree was checked against the pinned upstream source as described above.
