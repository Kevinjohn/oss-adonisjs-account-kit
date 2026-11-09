# Contributing

## Before you start

- For a bug, open an issue with a reproduction first, unless the fix is a one-line change.
- For a new feature or a behavior change, open an issue to agree on the shape before writing code.
  Account Kit keeps a small public surface on purpose.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md). Do not open a
  public issue.

## Project principles

Every change follows these.

- **Built for everyone who uses AdonisJS.** Follow the open-source AdonisJS packages and starter
  kits for names, shapes and behavior. Match AdonisJS Plus only where that costs nothing; Plus
  compatibility is not a goal and never outweighs consistency for open-source users.
- **The application owns its language.** Do what the official AdonisJS packages do: look up
  user-facing text through `@adonisjs/i18n` when the application uses it, with English as the
  fallback. No locale detection, no package language setting, and no translations or loader
  shipped in the package.

## Local setup

You need Node.js 24 and pnpm. The repository pins Node 24 in `.nvmrc`; `better-sqlite3` is compiled
against it and the tests fail under other versions.

```sh
nvm use
pnpm install
pnpm quick:test
```

## Checks

- `pnpm check` runs formatting, lint, types, SQLite tests, build, built exports and built setup.
- `pnpm check --full` appends PostgreSQL, coverage, experimental MySQL, the default consumer,
  the API password-reset recipe and the docs build. Compatibility matrices and standalone example journeys
  remain separate gates.

Run the repository scripts, not the bare tools. They carry the flags used by CI.

| Script                    | What it does                                              |
| ------------------------- | --------------------------------------------------------- |
| `pnpm format:check`       | Checks formatting on tracked files                        |
| `pnpm lint`               | Runs ESLint with the AdonisJS config                      |
| `pnpm typecheck`          | Runs TypeScript without emitting                          |
| `pnpm quick:test`         | Runs the Japa suite against SQLite                        |
| `pnpm test`               | Runs `pnpm quick:test` with coverage thresholds           |
| `pnpm test:pg`            | Runs the suite against a local PostgreSQL 16 database     |
| `pnpm build`              | Compiles to `build/`                                      |
| `pnpm prepare`            | On install, compiles only when `build/` is missing        |
| `pnpm test:built-exports` | Checks the package's built exports                        |
| `pnpm test:built-setup`   | Checks built Ace setup and packaged migration templates   |
| `pnpm test:consumer`      | Packs the package and checks it in a consumer application |

`pnpm test:pg` needs PostgreSQL 16 binaries (`brew install postgresql@16` on macOS). To use your
own server instead, set `DB_CLIENT=pg` plus `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and
`DB_DATABASE`, then run `pnpm quick:test`.

Changes to account operations should pass on both SQLite and PostgreSQL. The `checks` workflow
runs both databases on every pull request. Its SQLite leg checks formatting, lint and types, then
compiles the package and checks its built exports. Lint runs once there: the workflow's test and
compile steps turn off the `pretest` and `precompile` hooks, which `pnpm test` and `pnpm build`
still run locally.

The `compat` workflow checks minimum and latest peer versions weekly and before a release. It also
checks the packed consumer application and experimental MySQL 8.4 compatibility. The `examples`
workflow checks recipes and example applications. The `starter-examples` workflow assembles the
examples into the [starter examples sandbox](https://github.com/Kevinjohn/oss-adonisjs-starter-examples)
and tests the combined apps at release and on manual dispatch, not on pull requests; a failing kit
blocks the release.

The _Tested against_ table in `README.md` mirrors `.github/workflows/checks.yml` and
`.github/workflows/compat.yml`; change them in the same PR.

## Code layout

- `src/` holds the account operations, one responsibility per file.
- `src/http/` holds the optional managed JSON routes.
- `src/setup/` holds the `account-kit:setup` planner.
- `commands/` holds Ace commands, `providers/` the AdonisJS provider and `stubs/` the generated
  config and migrations.
- `tests/` mirrors the source: one spec per module. Shared fixtures live in `tests/helpers/`.
- `bin/` holds package scripts and `bin/helpers/` modules used only by those scripts.

[AGENTS.md](AGENTS.md) describes the file-size and file-splitting rules the codebase follows.

## Planning files

Private plans, PRDs and review notes live in a gitignored `plans/` directory, or as `PLAN*.md` and
`__PRD*.md` in the root; `.gitignore` keeps all three out of commits. Delete a plan once its work
has landed. Reference material for contributors goes in `docs/maintainers/` instead.

## Pull requests

- Keep each pull request to one change.
- Add or update tests. A bug fix should include a test that fails without the fix.
- Update the relevant page in `docs/` and add a line under `## Unreleased` in
  [CHANGELOG.md](CHANGELOG.md) when behavior visible to users changes.
- Error `code` values are public API. Changing or removing one needs a breaking entry in
  [CHANGELOG.md](CHANGELOG.md); see [error code stability](docs/reference/errors.md#stability).
- Write commit messages in the imperative mood, describing the change ("Reject expired invitation
  tokens on resend").

## Repository-specific

### Adding a translation

Translations are copy-paste pages in the docs, not files in the package.

1. Copy the `errors.json` and `validator.json` blocks from
   [docs/guide/managed-http.md](docs/guide/managed-http.md) into
   `docs/guide/translations/<locale>.md`, following
   [docs/guide/translations/index.md](docs/guide/translations/index.md).
2. Translate the values. Keep every key and every `{placeholder}`.
3. Add the locale to the list in `docs/guide/translations/index.md`.
4. Run `pnpm quick:test --files=docs_translations.spec.ts`. It checks keys, ICU syntax and
   placeholders, not wording.

### Documentation examples from the example apps

When a guide shows code that an example application runs, keep the code in the example and mark
it with `// #region example_name` and `// #endregion example_name`. Put
`<!-- source: relative/path/to/file.ts#example_name -->` before the matching code fence in the
guide. `tests/docs_source_examples.spec.ts` fails when the fence and the region differ, so change
both together.

### Adapters

A users adapter for another ORM is a good first contribution. The adapter contract suite in
`@kevinjohn/adonisjs-account-kit/testing/adapter_contract` checks an adapter against the same behavior the
Lucid adapter passes.

## Code of conduct

Everyone taking part in this project follows the [code of conduct](CODE_OF_CONDUCT.md).
