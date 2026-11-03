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

Run the repository scripts, not the bare tools. They carry the flags used by CI.

| Script | What it does |
| --- | --- |
| `pnpm format:check` | Checks formatting on tracked files |
| `pnpm lint` | Runs ESLint with the AdonisJS config |
| `pnpm typecheck` | Runs TypeScript without emitting |
| `pnpm quick:test` | Runs the Japa suite against SQLite |
| `pnpm test` | Runs `pnpm quick:test` with coverage thresholds |
| `pnpm test:pg` | Runs the suite against a local PostgreSQL 16 database |
| `pnpm build` | Compiles to `build/` |
| `pnpm test:built-exports` | Checks the package's built exports |
| `pnpm test:consumer` | Packs the package and checks it in a consumer application |

`pnpm test:pg` needs PostgreSQL 16 binaries (`brew install postgresql@16` on macOS). To use your
own server instead, set `DB_CLIENT=pg` plus `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and
`DB_DATABASE`, then run `pnpm quick:test`.

Changes to account operations should pass on both SQLite and PostgreSQL. The `checks` workflow
runs both databases on every pull request. Its SQLite leg checks formatting, lint and types, then
builds the package and checks its built exports. `pnpm test` runs lint first through `pretest`.

The `compat` workflow checks minimum and latest peer versions weekly and before a release. It also
checks the packed consumer application and experimental MySQL 8.4 compatibility. The `examples`
workflow checks recipes and example applications.

The *Tested against* table in `README.md` mirrors `.github/workflows/checks.yml` and
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

### Adapters

A users adapter for another ORM is a good first contribution. The adapter contract suite in
`adonisjs-account-kit/testing/adapter_contract` checks an adapter against the same behavior the
Lucid adapter passes.

## Code of conduct

Everyone taking part in this project follows the [code of conduct](CODE_OF_CONDUCT.md).
