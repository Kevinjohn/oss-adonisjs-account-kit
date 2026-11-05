// Scaffolds a fresh AdonisJS API app beside a tarball of this checkout, for the demo scripts.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { packCheckout, run } from './pack_checkout.js'

/** Reads the app directory from the command line, then packs the checkout and creates the app. */
export function createAdonisApp(script: string) {
  const [target] = process.argv.slice(2)
  if (!target) throw new Error(`Usage: node bin/demos/${script} <app-dir>`)
  const appDir = resolve(target)
  if (existsSync(appDir))
    throw new Error(`${appDir} already exists; remove it or pick another path`)

  // The default targets live under the gitignored tmp/, which a fresh clone does not have.
  mkdirSync(dirname(appDir), { recursive: true })
  const archiveDir = mkdtempSync(join(dirname(appDir), `${basename(appDir)}.account-kit-archive-`))
  const { archivePath } = packCheckout(join(archiveDir, 'candidate.tgz'))
  run(
    'pnpm',
    ['dlx', 'create-adonisjs@3.4.0', basename(appDir), '--kit=api', '--pkg=pnpm'],
    dirname(appDir)
  )
  return { appDir, archivePath }
}
