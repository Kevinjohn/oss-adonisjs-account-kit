# Agent instructions

## Node version

- Use Node 24 for every command in this repository. `package.json` requires `node >=24` and the
  `better-sqlite3` binary is compiled against it; under Node 22 the test suite fails with
  `NODE_MODULE_VERSION` errors.
- `.nvmrc` pins `24`. If the shell starts on another version, run `nvm use` (or put
  `~/.nvm/versions/node/v24.*/bin` first on `PATH`) before `pnpm` commands.

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

- Run the repository scripts, not the bare tools: `pnpm lint`, `pnpm typecheck`, `pnpm build`,
  `pnpm quick:test` (SQLite), `pnpm test:pg-service`, and `pnpm test:pg` (local PostgreSQL 16
  required; see the checklist in docs/maintainers/verification.md and its PostgreSQL section for the external-server alternative).

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
