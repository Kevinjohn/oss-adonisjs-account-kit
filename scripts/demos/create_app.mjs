// Builds a fresh AdonisJS API app with the packed Account Kit, ready for record.mjs.
// Usage: node scripts/demos/create_app.mjs <app-dir>
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [target] = process.argv.slice(2)
if (!target) throw new Error('Usage: node scripts/demos/create_app.mjs <app-dir>')
const appDir = resolve(target)
if (existsSync(appDir)) throw new Error(`${appDir} already exists; remove it or pick another path`)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const overlay = fileURLToPath(new URL('overlay', import.meta.url))

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })

// The demo runs the package as it is in this checkout, not the published release.
run('pnpm', ['build'], repoRoot)
run(
  'pnpm',
  ['--config.verify-deps-before-run=false', 'pack', '--pack-destination', dirname(appDir)],
  repoRoot
)
const tarball = readdirSync(dirname(appDir)).find((file) =>
  /^adonisjs-account-kit-.*\.tgz$/.test(file)
)
if (!tarball) throw new Error('pnpm pack wrote no tarball')

run(
  'npx',
  ['-y', 'create-adonisjs@3.4.0', basename(appDir), '--kit=api', '--pkg=npm'],
  dirname(appDir)
)
run('npm', ['install', join('..', tarball), '@adonisjs/limiter', 'typescript@^5.9.3'], appDir)
run('node', ['ace', 'configure', '@adonisjs/limiter', '--store=database'], appDir)
run('node', ['ace', 'configure', 'adonisjs-account-kit'], appDir)

// Every capability except social sign-in, managed routes under /api, emails printed to the log.
cpSync(overlay, appDir, { recursive: true })
appendFileSync(join(appDir, 'start/routes.ts'), "import './account_kit_routes.js'\n")
console.log(`Demo app ready in ${appDir}`)
