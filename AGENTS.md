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
