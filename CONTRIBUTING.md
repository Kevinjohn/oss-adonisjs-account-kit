# Contributing

Thanks for helping. Bug reports, documentation fixes, recipes and adapters are all welcome.

## Before you start

- For a bug, open an issue with a reproduction first, unless the fix is a one-line change.
- For a new feature or a behavior change, open an issue to agree the shape before writing code.
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

To skip local setup, open the repository in GitHub Codespaces. The dev container installs Node 24,
pnpm and the dependencies; run `pnpm quick:test` once it is ready.

## Checks

Run the repository scripts, not the bare tools. They carry the flags the release gate uses.

| Script               | What it does                                                      |
| -------------------- | ----------------------------------------------------------------- |
| `pnpm lint`          | ESLint with the AdonisJS config                                   |
| `pnpm typecheck`     | TypeScript without emitting                                       |
| `pnpm quick:test`    | Japa test suite against SQLite                                    |
| `pnpm test`          | The SQLite suite under c8; fails below 94% lines, 90% branches    |
| `pnpm test:pg`       | The same suite against a throwaway local PostgreSQL 16 cluster    |
| `pnpm build`         | Compiles to `build/`                                              |
| `pnpm test:consumer` | Packs the package and installs it into a copy of `examples/api`   |
| `pnpm check:changed` | The checks above that cover the files changed since `origin/main` |

`pnpm check:changed [base]` runs Prettier and ESLint on the changed files (the whole repository
when their configuration or dependencies changed), the type-check when TypeScript or dependencies
changed, the changed specs (or the full SQLite suite when any other file changed), the `pg.sh`
script tests when they changed, and the docs build when docs, exported sources or dependencies
changed. It does not run `pnpm test:pg`, `pnpm build` or `pnpm test:consumer`.

`pnpm test:pg` needs PostgreSQL 16 binaries (`brew install postgresql@16` on macOS). To use your
own server instead, set `DB_CLIENT=pg` plus `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and
`DB_DATABASE`, then run `pnpm quick:test`.

Changes to account operations should pass on both SQLite and PostgreSQL. The `checks` workflow runs
both on every pull request.

`pnpm test:consumer` and the example app's own checks run locally, not in the `checks` workflow.
Run them before a release and after changing `configure.ts`, `stubs/` or `examples/api`; the
[release gate](docs/maintainers/release-gate.md) records when they move to hosted CI.

## Code layout

- `src/` holds the account operations, one responsibility per file.
- `src/http/` holds the optional managed JSON routes.
- `src/setup/` holds the `account-kit:setup` planner.
- `commands/` holds the Ace commands, `providers/` the AdonisJS provider and `stubs/` the generated
  config and migrations.
- `tests/` mirrors the source: one spec per module. Shared fixtures live in `tests/helpers/`.

[AGENTS.md](AGENTS.md) describes the file-size and file-splitting rules the codebase follows.

## Pull requests

- Keep each pull request to one change.
- Add or update tests. A bug fix should include a test that fails without the fix.
- Update the relevant page in `docs/` and add a line under `## Unreleased` in
  [CHANGELOG.md](CHANGELOG.md) when behavior visible to users changes.
- Error `code` values are public API. Changing or removing one needs a breaking entry in
  [CHANGELOG.md](CHANGELOG.md); see [error code stability](docs/reference/errors.md#stability).
- Write commit messages in the imperative mood, describing the change ("Reject expired invitation
  tokens on resend").

## Adding a translation

Translations are copy-paste pages in the docs, not files in the package.

1. Copy the `errors.json` and `validator.json` blocks from
   [docs/managed-http.md](docs/managed-http.md) into `docs/translations/<locale>.md`, following
   [docs/translations/index.md](docs/translations/index.md).
2. Translate the values. Keep every key and every `{placeholder}`.
3. Add the locale to the list in `docs/translations/index.md`.
4. Run `pnpm quick:test --files=docs_translations.spec.ts`. It checks keys, ICU syntax and
   placeholders, not wording.

## Adapters

A users adapter for another ORM is a good first contribution. The adapter contract suite in
`adonisjs-account-kit/testing/adapter_contract` checks an adapter against the same behavior the
Lucid adapter passes.

## Code of conduct

Everyone taking part in this project follows the [code of conduct](CODE_OF_CONDUCT.md).
