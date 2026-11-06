// Compiles the package on install when `build/` is missing, so a git commit pin installs a built
// package. A checked-out repository compiles once on its first install and is skipped afterwards.
// `pnpm pack --json` runs this too, so everything goes to stderr and stdout stays clean.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
if (existsSync(new URL('../build/index.js', import.meta.url))) {
  console.error('[prepare] build/ present, nothing to compile')
} else {
  // Pre and post scripts are off: lint stays a check, and templates are copied explicitly.
  for (const script of ['compile', 'copy:templates']) {
    console.error(`[prepare] pnpm ${script}`)
    const result = spawnSync('pnpm', ['--config.enable-pre-post-scripts=false', 'run', script], {
      cwd: root,
      stdio: ['ignore', process.stderr, 'inherit'],
    })
    // pnpm missing from PATH (an npm or yarn install) leaves no exit status; say why.
    if (result.error) console.error(`[prepare] ${result.error.message}`)
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
