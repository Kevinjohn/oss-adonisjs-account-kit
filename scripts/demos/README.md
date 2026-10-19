# Feature recordings

These scripts make the terminal recordings in `docs/assets/demos/`, shown on
[See it run](../../docs/recordings.md) and the feature pages.

```sh
pnpm demos
```

It runs three steps, which can also be run alone:

1. `create_app.mjs tmp/demo-app` builds and packs this checkout, creates a new AdonisJS API app
   with `create-adonisjs@3.4.0`, installs the tarball and the limiter, and copies `overlay/` in:
   every capability except social sign-in, managed routes under `/api`, emails printed to the log.
2. `record.mjs tmp/demo-app tmp/demo-casts [scenario ...]` runs each scenario with real `curl`
   and `node ace` commands and writes one asciicast v2 file per scenario. Each scenario starts
   from `migration:fresh`, which also empties the limiter store. It needs port 3333 free.
3. `render.mjs tmp/demo-casts docs/assets/demos` converts the casts to SVG with
   `svg-term-cli@2.1.1`.

Remove `tmp/demo-app` before running `pnpm demos` again; `create_app.mjs` refuses an existing
directory. Tokens, ids and times differ on every run.
