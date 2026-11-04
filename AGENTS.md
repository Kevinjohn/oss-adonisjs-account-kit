# Agent instructions

## Node version

Use Node 24 (`.nvmrc`) for every command. CI tests Node 24 only. `better-sqlite3` is compiled
against Node 24; under Node 22 the test suite fails with `NODE_MODULE_VERSION` errors.

## Project principles

The same rules as `CONTRIBUTING.md`; every change follows them.

- **Built for everyone who uses AdonisJS.** Follow the open-source AdonisJS packages and starter
  kits for names, shapes and behavior. Match AdonisJS Plus only where that costs nothing; Plus
  compatibility is not a goal and never outweighs consistency for open-source users.
- **The application owns its language.** Do what the official AdonisJS packages do: look up
  user-facing text through `@adonisjs/i18n` when the application uses it, with English as the
  fallback. No locale detection, no package language setting, and no translations or loader
  shipped in the package.

## Checks

- `pnpm check` runs formatting, lint, types, SQLite tests, build, built exports and built setup.
- `pnpm check --full` appends PostgreSQL, coverage, experimental MySQL, the default consumer,
  a recipe check and the docs build. It does not run every compatibility or example scenario.
- The current full-profile recipe step lacks a selection; use
  `pnpm test:recipe --recipe=api-password-reset` until that invocation is repaired.
- `pnpm typecheck` runs TypeScript without emitting.
- `pnpm lint` runs ESLint with the AdonisJS config.
- `pnpm format` formats the repository with Prettier.
- `pnpm format:check` checks formatting for tracked files.
- `pnpm quick:test` runs the Japa suite against SQLite.
- `pnpm pretest` runs lint before the test suite.
- `pnpm test` runs the SQLite suite with coverage thresholds.
- `pnpm test:built-exports` checks the package's built exports.
- `pnpm test:consumer` packs and checks the package in a consumer application.
- `pnpm test:pg` runs the suite against a local PostgreSQL 16 database.
- `pnpm pg:start` starts the local PostgreSQL 16 service.
- `pnpm pg:stop` stops the local PostgreSQL 16 service.
- `pnpm test:mysql` runs the experimental MySQL suite.
- `pnpm check:changed` runs checks for files changed from the selected base.
- `pnpm precompile` runs lint before compilation.
- `pnpm compile` compiles JavaScript and type declarations.
- `pnpm postcompile` copies templates into `build/`.
- `pnpm build` runs the package compilation scripts.
- `pnpm docs:api` generates the API reference.
- `pnpm docs:dev` generates the API reference and serves the documentation site.
- `pnpm docs:build` generates the API reference and builds the documentation site.

## Single Responsibility Principle (files)

Each file does one thing and is named for it. This keeps the codebase easy to hold in your head,
even if it means more files.

1. One responsibility per file. If you need "and" to describe it, it is two files.
2. Name the file for the responsibility. A reader should guess what
   `src/setup/config_inspection.ts` does without opening it.
3. Split at a seam, not at a line count. A seam is a group of functions that share data or a
   purpose and that the rest of the file only calls. A file that just forwards calls is not a
   seam; leave it in place.
4. Size is a prompt, not a rule. At about 800 lines, look for a seam. At about 1,500, split in the
   next change that touches the file. A file kept large on purpose (a data table, generated code,
   one long table-driven test) says why in a short comment at the top.
5. Keep the entry point. The original file re-exports what its importers use, so nothing outside
   the directory changes.
6. Move, do not edit. A split commit only moves code. Run the repository scripts before any
   further change.
7. Tests follow the source. One spec per module or closely related pair. Shared fixtures go in
   `tests/helpers/` once. Do not rename tests while moving them.
8. Small and cohesive is finished. Do not split a file that is under the first threshold and does
   one thing.

## Folder layout

```
index.ts                    public entry
configure.ts                `node ace configure` hook
providers/<name>_provider.ts AdonisJS provider
commands/                   Ace commands
services/main.ts            container service
stubs/                      configure templates
src/                        implementation; `src/types.ts` and `src/errors.ts` hold public types and errors
<subpath>/main.ts           top-level folder only when it backs a package export
bin/                        package scripts (`.ts` via ts-exec; `.sh` allowed)
bin/helpers/                modules used only by `bin/`
tests/                      Japa specs, flat
tests/helpers/              shared test helpers
tests/fixtures/              static fixtures
tests/tooling/              specs for scripts
tests/types/                type-level tests (`.ts`, not `.spec.ts`), where present
examples/                   example applications
docs/                       documentation
```

1. A top-level folder exists only for an exported subpath. Anything else goes in `src/`.
2. Scripts are TypeScript under `bin/`, run with `node --import=@poppinss/ts-exec`. Use `.mjs`
   only when the script must run before dependencies are installed, and explain why in a comment
   at the top.
3. Use one Japa config with `files: ['tests/**/*.spec.ts']`; do not add suites or `node --test`
   scripts.
4. Do not add a `scripts/` folder.

## Repository-specific

The application owns its language. Look up user-facing text through `@adonisjs/i18n` when the
application uses it, with English as the fallback. Do not add locale detection, a package language
setting, translations or a loader to this package.
