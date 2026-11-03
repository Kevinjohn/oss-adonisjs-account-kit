// Builds and packs this checkout so a demo app runs the package as it is here, not the release.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })

/** Writes the package tarball into a directory and returns its file name. */
export function packCheckout(destination) {
  run('pnpm', ['build'], repoRoot)
  run(
    'pnpm',
    ['--config.verify-deps-before-run=false', 'pack', '--pack-destination', destination],
    repoRoot
  )
  const tarball = readdirSync(destination).find((file) =>
    /^adonisjs-account-kit-.*\.tgz$/.test(file)
  )
  if (!tarball) throw new Error('pnpm pack wrote no tarball')
  return tarball
}
