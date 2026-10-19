// Scaffolds a fresh AdonisJS API app beside a tarball of this checkout, for the demo scripts.
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { packCheckout, run } from './pack_checkout.mjs'

/** Reads the app directory from the command line, then packs the checkout and creates the app. */
export function createAdonisApp(script) {
  const [target] = process.argv.slice(2)
  if (!target) throw new Error(`Usage: node scripts/demos/${script} <app-dir>`)
  const appDir = resolve(target)
  if (existsSync(appDir))
    throw new Error(`${appDir} already exists; remove it or pick another path`)

  const tarball = packCheckout(dirname(appDir))
  run(
    'npx',
    ['-y', 'create-adonisjs@3.4.0', basename(appDir), '--kit=api', '--pkg=npm'],
    dirname(appDir)
  )
  return { appDir, tarball }
}
