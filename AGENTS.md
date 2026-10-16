# Agent instructions

## Node version

- Use Node 24 for every command in this repository. `package.json` requires `node >=24` and the
  `better-sqlite3` binary is compiled against it; under Node 22 the test suite fails with
  `NODE_MODULE_VERSION` errors.
- `.nvmrc` pins `24`. If the shell starts on another version, run `nvm use` (or put
  `~/.nvm/versions/node/v24.*/bin` first on `PATH`) before `pnpm` commands.

## Checks

- Run the repository scripts, not the bare tools: `pnpm lint`, `pnpm typecheck`, `pnpm build`,
  `pnpm quick:test` (SQLite), `pnpm test:pg-service`, and `pnpm test:pg` (local PostgreSQL 16
  required; see docs/verification.md for the external-server alternative).

## File size and responsibility

This is a guideline, not a rule. It exists because one-responsibility files are easier for a
newcomer, a reviewer, or a language model to hold in their head.

- Aim for one responsibility per file, named for that responsibility. A reader should be able to
  guess what `src/setup/config_inspection.ts` does without opening it.
- Treat about 800 lines as the point to look for a seam, and about 1,500 as the point to split in
  the next change that touches the file. Neither number blocks a merge; a file that stays large on
  purpose (a data table, generated code, one long table-driven test) says why in a short comment
  at the top.
- Split by responsibility, not by line count. Keep the existing entry point re-exporting what its
  importers use, so nothing outside the directory changes. Move code without editing it, in its
  own commit, and verify with the repository scripts before any further edit.
- Test files follow the source they cover: one spec per module or closely related pair, with
  shared fixtures lifted once into `tests/helpers/`. Do not rename tests while moving them.
- The costs are real: more files to navigate, more import lines, and the temptation to split
  before a seam exists. When a file is under the first threshold and cohesive, leave it alone.
